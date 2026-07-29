-- ============================================================================
-- Module: newsletters
-- Migration: 076_tz_local_grace_window
-- Description: Fix tz_local ("recipient local time") send timing so it staggers
-- correctly regardless of when the send is scheduled.
--
-- THE BUG: the per-recipient send time was
--     GREATEST(scheduled_at, <target_local on SCHEDULE_DATE in recipient tz>)
-- where SCHEDULE_DATE = scheduled_at's date *in the Default timezone*. When the
-- scheduled instant fell on the previous evening in the default tz (e.g. 01:07
-- UTC = 18:07 the day before in America/Los_Angeles), the schedule date landed a
-- day early, so target_local (09:46) had "already passed" for EVERY timezone →
-- the clamp fired for all → the whole list blasted at the scheduled instant
-- instead of staggering across recipients' local mornings.
--
-- THE FIX (public.gw_tz_local_send_at): compute the target per recipient in
-- THEIR OWN timezone, on the local calendar day of the scheduled instant, with a
-- grace window:
--   * target still ahead today            -> deliver at their local target (wait)
--   * target just passed (within 2h grace)-> deliver at the scheduled instant
--   * target long past (> grace)          -> deliver at their NEXT local target
-- So Europe/US wait for their local 09:46 (staggered across the day) while only
-- the few far-east zones that just passed 09:46 go out at the scheduled instant.
-- Reconciles both prior complaints (068 roll-forward pushed just-missed eastern
-- recipients to tomorrow; 072 hard clamp blasted everyone on evening schedules).
-- ============================================================================

-- Shared helper (defined identically in the broadcasts module too, so either can
-- be installed standalone). p_target_local is 'HH:MM'; p_grace defaults to 2h.
CREATE OR REPLACE FUNCTION public.gw_tz_local_send_at(
  p_anchor       timestamptz,
  p_target_local text,
  p_tz           text,
  p_grace        interval DEFAULT interval '2 hours'
) RETURNS timestamptz
LANGUAGE sql
STABLE
AS $fn$
  SELECT CASE
    -- Target local time is still ahead on the recipient's local day → wait for it.
    WHEN ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz) >= p_anchor
      THEN ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz)
    -- Just passed (within grace) → send at the scheduled instant, don't wait a day.
    WHEN p_anchor - ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz) <= p_grace
      THEN p_anchor
    -- Long past → the recipient's next local target (next calendar day, DST-safe).
    ELSE ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + interval '1 day' + p_target_local::time) AT TIME ZONE p_tz)
  END
$fn$;

COMMENT ON FUNCTION public.gw_tz_local_send_at(timestamptz, text, text, interval) IS
  'Per-recipient tz_local send time: target local time (HH:MM) on the recipient''s local calendar day of the schedule anchor. Ahead today -> use it; just passed (<= grace, default 2h) -> the anchor; long past -> next local day. Replaces the default-tz schedule-date + hard clamp that blasted everyone on evening schedules.';

-- --------------------------------------------------------------------------
-- Fan-out (the live path the dispatch-scheduled worker loops over).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients_batch(p_send_id uuid, p_batch_size integer DEFAULT 5000, p_after_email text DEFAULT NULL::text)
 RETURNS TABLE(inserted integer, last_email text, remaining boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_send       public.newsletter_sends%ROWTYPE;
  v_list_id    uuid;
  v_target     text;
  v_strategy   text;
  v_anchor     timestamptz;
  v_default_tz text;
  v_batch      integer;
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
        ELSE public.gw_tz_local_send_at(v_anchor, v_target, tzn.name)
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

-- --------------------------------------------------------------------------
-- Pre-send confirmation preview (the modal). Stays SECURITY DEFINER (075).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletter_preview_send_schedule(p_list_id uuid, p_scheduled_at timestamp with time zone, p_target_local text, p_default_timezone text)
 RETURNS TABLE(timezone text, recipients bigint, send_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_default_tz text;
  v_target     text := COALESCE(NULLIF(p_target_local, ''), '09:00');
BEGIN
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(p_default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  RETURN QUERY
  SELECT
    tzn.name,
    count(*)::bigint,
    public.gw_tz_local_send_at(p_scheduled_at, v_target, tzn.name)
  -- Join people by person_id (PK) rather than a per-row lower(email) lookup — the
  -- email lateral made this ~20-30s (over the 8s RPC cap); the PK join is ~3s.
  FROM public.list_subscriptions ls
  LEFT JOIN public.people p ON p.id = ls.person_id
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(p.attributes->>'timezone', '')
  CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, v_default_tz) AS name) tzn
  WHERE ls.list_id = p_list_id AND ls.subscribed = true
  GROUP BY tzn.name
  ORDER BY 3, 1;
END $function$;
