-- ============================================================================
-- Module: newsletters
-- Migration: 054_fanout_global_send_now
-- Description: Make fanout produce send_at = now() for the 'global' delivery
-- strategy, so "send to everyone now" can ride the SAME fanout → recipients
-- queue → worker drip engine as staggered sends (spec-central-sending-service.md;
-- collapses the Tier-1 edge processSend loop onto Tier 2). Previously the fanout
-- ALWAYS computed a per-recipient timezone-local target time (today at
-- target_local, default 09:00), which is correct for tz_local but wrong for an
-- immediate global send. tz_local behaviour is unchanged.
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
  v_send_date  date;
  v_target     text;
  v_strategy   text;
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

  v_strategy  := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local');
  v_target    := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_send_date := (COALESCE(v_send.scheduled_at, now())
                    AT TIME ZONE COALESCE(NULLIF(v_send.default_timezone, ''), 'UTC'))::date;

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id,
    pp.id,
    ls.email,
    -- global: everyone due now (the immediate send). tz_local/personalised:
    -- each recipient's local target time on the send date.
    CASE
      WHEN v_strategy = 'global' THEN now()
      ELSE ((v_send_date::text || ' ' || v_target)::timestamp
              AT TIME ZONE COALESCE(rtz.name, dtz.name, 'UTC'))
    END,
    'pending',
    v_strategy,
    COALESCE(rtz.name, dtz.name, 'UTC')
  FROM public.list_subscriptions ls
  LEFT JOIN LATERAL (
    SELECT id, attributes FROM public.people
    WHERE lower(email) = lower(ls.email)
    LIMIT 1
  ) pp ON true
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
  LEFT JOIN pg_timezone_names dtz ON dtz.name = NULLIF(v_send.default_timezone, '')
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
