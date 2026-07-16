-- ============================================================================
-- Module: newsletters
-- Migration: 072_fanout_send_at_clamp
-- Description: Correct tz_local send_at semantics. Each recipient's target is
-- target_local (e.g. 10:13) on the SEND'S SCHEDULE DATE in the recipient's own
-- timezone. If that local time is still ahead, deliver then; if it has ALREADY
-- PASSED at the schedule time, deliver immediately at the schedule time — never
-- roll to the next day.
--
--   send_at = GREATEST(scheduled_at, <target_local on schedule_date in rtz>)
--
-- Supersedes 068's roll-forward, which pushed already-passed (eastern)
-- recipients to tomorrow — the opposite of intended: the whole point of the
-- schedule time is that recipients past their local target go out as soon as the
-- schedule fires. schedule_date = the scheduled_at date in the send's default
-- timezone (the admin's local date). DST-safe (target built in local wall time,
-- then converted). 'global' unchanged (send_at = now()).
--
-- Redefines BOTH the single-shot and the batch fanout functions. CREATE OR
-- REPLACE only — no schema change.
-- ============================================================================

-- ---- Single-shot (kept for small / immediate callers) ----------------------
CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients(p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_send          public.newsletter_sends%ROWTYPE;
  v_list_id       uuid;
  v_target        text;
  v_strategy      text;
  v_anchor        timestamptz;
  v_default_tz    text;
  v_schedule_date date;
  v_inserted      integer;
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
  v_anchor   := COALESCE(v_send.scheduled_at, now());
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');
  v_schedule_date := (v_anchor AT TIME ZONE v_default_tz)::date;

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id, pp.id, ls.email,
    CASE
      WHEN v_strategy = 'global' THEN now()
      ELSE GREATEST(
        v_anchor,
        ((v_schedule_date::text || ' ' || v_target)::timestamp AT TIME ZONE tzn.name)
      )
    END,
    'pending', v_strategy, tzn.name
  FROM public.list_subscriptions ls
  LEFT JOIN LATERAL (
    SELECT id, attributes FROM public.people WHERE lower(email) = lower(ls.email) LIMIT 1
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

-- ---- Batch (the worker's chunked fanout) -----------------------------------
CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients_batch(
  p_send_id     uuid,
  p_batch_size  integer DEFAULT 5000,
  p_after_email text    DEFAULT NULL
)
RETURNS TABLE(inserted integer, last_email text, remaining boolean)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_send          public.newsletter_sends%ROWTYPE;
  v_list_id       uuid;
  v_target        text;
  v_strategy      text;
  v_anchor        timestamptz;
  v_default_tz    text;
  v_schedule_date date;
  v_batch         integer;
BEGIN
  SELECT * INTO v_send FROM public.newsletter_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % not found', p_send_id;
  END IF;
  v_list_id := (v_send.list_ids)[1];
  IF v_list_id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % has no list_ids to fan out', p_send_id;
  END IF;

  v_batch    := GREATEST(1, LEAST(COALESCE(p_batch_size, 5000), 20000));
  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_anchor   := COALESCE(v_send.scheduled_at, now());
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');
  v_schedule_date := (v_anchor AT TIME ZONE v_default_tz)::date;

  RETURN QUERY
  WITH slice AS (
    SELECT ls.email
    FROM public.list_subscriptions ls
    WHERE ls.list_id = v_list_id
      AND ls.subscribed = true
      AND (p_after_email IS NULL OR ls.email > p_after_email)
      AND (
        v_send.exclude_sent_send_ids IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.email_send_log esl
          WHERE esl.newsletter_send_id = ANY (v_send.exclude_sent_send_ids)
            AND esl.sent_at IS NOT NULL
            AND lower(esl.recipient_email) = lower(ls.email)
        )
      )
    ORDER BY ls.email
    LIMIT v_batch
  ),
  ins AS (
    INSERT INTO public.newsletter_send_recipients
      (send_id, person_id, email, send_at, status, strategy, timezone)
    SELECT
      p_send_id, pp.id, s.email,
      CASE
        WHEN v_strategy = 'global' THEN now()
        ELSE GREATEST(
          v_anchor,
          ((v_schedule_date::text || ' ' || v_target)::timestamp AT TIME ZONE tzn.name)
        )
      END,
      'pending', v_strategy, tzn.name
    FROM slice s
    LEFT JOIN LATERAL (
      SELECT id, attributes FROM public.people WHERE lower(email) = lower(s.email) LIMIT 1
    ) pp ON true
    LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
    CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, v_default_tz) AS name) tzn
    ON CONFLICT (send_id, email) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM ins)::integer          AS inserted,
    (SELECT max(email) FROM slice)               AS last_email,
    ((SELECT count(*) FROM slice) = v_batch)      AS remaining;
END $function$;

GRANT EXECUTE ON FUNCTION public.fanout_newsletter_send_recipients_batch(uuid, integer, text)
  TO authenticated, service_role;
