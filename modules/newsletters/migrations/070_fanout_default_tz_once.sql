-- ============================================================================
-- Module: newsletters
-- Migration: 070_fanout_default_tz_once
-- Description: Make fanout fast enough to finish under the PostgREST/role
-- statement_timeout (8s) so large tz_local sends don't get cancelled mid-fanout
-- and marked 'failed'.
--
-- Root cause: the fanout SELECT LEFT JOINed pg_timezone_names TWICE — once for
-- the recipient timezone (a hash join, fine) and once for the send's DEFAULT
-- timezone. The default-tz join was on a constant, and the planner re-scanned
-- the whole ~1200-row pg_timezone_names function once PER recipient (60k loops)
-- — the dominant ~6s of a ~20s fanout. Over the 8s RPC cap → "canceling
-- statement due to statement timeout" → send marked failed.
--
-- Fix: validate the default timezone ONCE into a variable (recipient tz is still
-- validated via the rtz hash join). No behavioural change to send_at; the 068
-- roll-forward logic is preserved. Also drops the ineffective in-body
-- `SET LOCAL statement_timeout` (it can't extend the already-running RPC
-- statement — see the timeout-probe finding).
--
-- CREATE OR REPLACE only — additive, no schema change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients(p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_send        public.newsletter_sends%ROWTYPE;
  v_list_id     uuid;
  v_target      text;
  v_strategy    text;
  v_anchor      timestamptz;
  v_default_tz  text;
  v_inserted    integer;
BEGIN
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
  -- Dispatch anchor: per-recipient local targets roll forward relative to this
  -- (see 068) so a passed target time resolves to the next day, not a past
  -- instant that fires immediately.
  v_anchor   := COALESCE(v_send.scheduled_at, now());

  -- Validate the send's DEFAULT timezone ONCE (previously a per-row join to
  -- pg_timezone_names that the planner re-scanned for every recipient). The
  -- recipient timezone is still validated via the rtz hash join below.
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id,
    pp.id,
    ls.email,
    CASE
      WHEN v_strategy = 'global' THEN now()
      ELSE (
        (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
        + CASE
            WHEN (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
                 >= (v_anchor AT TIME ZONE tzn.name)
            THEN interval '0 day'
            ELSE interval '1 day'
          END
      ) AT TIME ZONE tzn.name
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
  CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, v_default_tz) AS name) tzn
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
