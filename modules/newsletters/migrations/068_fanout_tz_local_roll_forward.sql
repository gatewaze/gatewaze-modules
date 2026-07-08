-- ============================================================================
-- Module: newsletters
-- Migration: 068_fanout_tz_local_roll_forward
-- Description: Fix tz_local / personalised fanout so each recipient's send_at is
-- the NEXT occurrence of target_local in their timezone AT OR AFTER the send's
-- dispatch moment — rolling forward a day when today's local target has already
-- passed.
--
-- Bug: 054 computed send_at as `target_local on scheduled_at's date` with no
-- roll-forward. When a send's scheduled_at time-of-day was later than
-- target_local (e.g. scheduled 21:01 UTC with a 09:46-local target), every
-- recipient's computed target had already elapsed by the time the send
-- dispatched, so the drip found the whole queue "due" and released all
-- recipients at once instead of holding each to their local time.
--
-- Fix: anchor to COALESCE(scheduled_at, now()); build the target in the
-- recipient's LOCAL wall-clock (DST-safe) and add a day when it's already in the
-- past relative to the anchor. 'global' is unchanged (send_at = now()).
--
-- CREATE OR REPLACE only — additive, no schema change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients(p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_send       public.newsletter_sends%ROWTYPE;
  v_list_id    uuid;
  v_target     text;
  v_strategy   text;
  v_anchor     timestamptz;
  v_inserted   integer;
BEGIN
  SET LOCAL statement_timeout = '10min';

  SELECT * INTO v_send FROM public.newsletter_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % not found', p_send_id;
  END IF;

  v_list_id := (v_send.list_ids)[1];
  IF v_list_id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % has no list_ids to fan out', p_send_id;
  END IF;

  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  -- Dispatch anchor: when the send goes live. Per-recipient local targets are
  -- computed relative to this so a target time that has already passed today
  -- rolls to the next day rather than resolving to a past instant (which the
  -- drip would send immediately).
  v_anchor   := COALESCE(v_send.scheduled_at, now());

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id,
    pp.id,
    ls.email,
    CASE
      WHEN v_strategy = 'global' THEN now()
      ELSE (
        -- Recipient-local wall time of the dispatch anchor.
        (
          (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
          + CASE
              WHEN (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
                   >= (v_anchor AT TIME ZONE tzn.name)
              THEN interval '0 day'   -- today's local target still ahead
              ELSE interval '1 day'   -- already passed → next day
            END
        ) AT TIME ZONE tzn.name
      )
    END,
    'pending',
    v_strategy,
    tzn.name
  FROM public.list_subscriptions ls
  LEFT JOIN LATERAL (
    SELECT id, attributes FROM public.people
    WHERE lower(email) = lower(ls.email)
    LIMIT 1
  ) pp ON true
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
  LEFT JOIN pg_timezone_names dtz ON dtz.name = NULLIF(v_send.default_timezone, '')
  -- Resolved timezone (recipient → send default → UTC), reused above.
  CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, dtz.name, 'UTC') AS name) tzn
  WHERE ls.list_id = v_list_id
    AND ls.subscribed = true
    AND (
      v_send.exclude_sent_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.newsletter_send_id = ANY (v_send.exclude_sent_send_ids)
          AND esl.sent_at IS NOT NULL
          AND lower(esl.recipient_email) = lower(ls.email)
      )
    )
  ON CONFLICT (send_id, email) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.newsletter_sends
  SET total_recipients = (SELECT count(*) FROM public.newsletter_send_recipients WHERE send_id = p_send_id),
      updated_at = now()
  WHERE id = p_send_id;

  RETURN v_inserted;
END $function$;
