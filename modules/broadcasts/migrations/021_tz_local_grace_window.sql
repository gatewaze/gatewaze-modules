-- ============================================================================
-- Module: broadcasts
-- Migration: 021_tz_local_grace_window
-- Description: Same tz_local send-timing fix as newsletters 076, applied to the
-- broadcast fan-out + pre-send preview. Replaces the "target_local on the
-- schedule date (in the Default timezone), hard-clamped to the schedule time"
-- rule — which blasted the whole audience at once whenever the scheduled instant
-- was evening-in-the-default-tz — with a per-recipient grace window computed in
-- each recipient's own timezone (public.gw_tz_local_send_at). Europe/US wait for
-- their local target; only the few far-east zones that just passed it go out at
-- the scheduled instant. See newsletters/076 for the full rationale.
-- ============================================================================

-- Shared helper (identical to newsletters/076 — CREATE OR REPLACE is idempotent
-- when both modules are installed; either can be installed standalone).
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
    WHEN ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz) >= p_anchor
      THEN ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz)
    WHEN p_anchor - ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + p_target_local::time) AT TIME ZONE p_tz) <= p_grace
      THEN p_anchor
    ELSE ((date_trunc('day', (p_anchor AT TIME ZONE p_tz)) + interval '1 day' + p_target_local::time) AT TIME ZONE p_tz)
  END
$fn$;

COMMENT ON FUNCTION public.gw_tz_local_send_at(timestamptz, text, text, interval) IS
  'Per-recipient tz_local send time: target local time (HH:MM) on the recipient''s local calendar day of the schedule anchor. Ahead today -> use it; just passed (<= grace, default 2h) -> the anchor; long past -> next local day. Replaces the default-tz schedule-date + hard clamp that blasted everyone on evening schedules.';

-- --------------------------------------------------------------------------
-- Fan-out (the live path the broadcast dispatch-scheduled worker loops over).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fanout_broadcast_send_recipients_batch(p_send_id uuid, p_batch_size integer DEFAULT 5000, p_after_email text DEFAULT NULL::text)
 RETURNS TABLE(inserted integer, last_email text, remaining boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_send       public.broadcast_sends%ROWTYPE;
  v_target     text;
  v_strategy   text;
  v_default_tz text;
  v_anchor     timestamptz;
  v_batch      integer;
BEGIN
  SELECT * INTO v_send FROM public.broadcast_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'broadcast_send % not found', p_send_id;
  END IF;
  IF v_send.audience_type = 'segment' AND v_send.segment_id IS NULL THEN
    RAISE EXCEPTION 'broadcast_send % has audience_type=segment but no segment_id', p_send_id;
  END IF;
  IF v_send.audience_type = 'list' AND COALESCE(array_length(v_send.list_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'broadcast_send % has audience_type=list but no list_ids', p_send_id;
  END IF;

  v_batch    := GREATEST(1, LEAST(COALESCE(p_batch_size, 5000), 20000));
  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'global');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_anchor   := COALESCE(v_send.scheduled_at, now());
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  RETURN QUERY
  WITH aud AS (
    SELECT pp.id AS person_id, pp.email AS email, pp.attributes AS attributes
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE v_send.audience_type = 'segment'
      AND sm.segment_id = v_send.segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    SELECT pp.id AS person_id, ls.email AS email, pp.attributes AS attributes
    FROM public.list_subscriptions ls
    LEFT JOIN LATERAL (
      SELECT id, attributes FROM public.people WHERE lower(email) = lower(ls.email) LIMIT 1
    ) pp ON true
    WHERE v_send.audience_type = 'list'
      AND ls.list_id = ANY (v_send.list_ids::uuid[])
      AND ls.subscribed = true
      AND ls.email IS NOT NULL AND ls.email <> ''
  ),
  slice AS (
    SELECT person_id, email, attributes
    FROM aud
    WHERE (p_after_email IS NULL OR email > p_after_email)
    ORDER BY email
    LIMIT v_batch
  ),
  ins AS (
    INSERT INTO public.broadcast_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
    SELECT
      p_send_id,
      s.person_id,
      s.email,
      CASE WHEN v_strategy = 'global'
        THEN now()
        ELSE public.gw_tz_local_send_at(v_anchor, v_target, COALESCE(rtz.name, v_default_tz))
      END,
      'pending',
      v_strategy,
      COALESCE(rtz.name, v_default_tz)
    FROM slice s
    LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(s.attributes->>'timezone', '')
    WHERE
      NOT EXISTS (
        SELECT 1 FROM public.broadcast_suppressions sup
        WHERE lower(sup.email) = lower(s.email)
          AND (sup.topic = v_send.suppression_topic OR sup.topic = 'all')
      )
      AND (
        v_send.exclude_sent_send_ids IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.email_send_log esl
          WHERE esl.broadcast_send_id = ANY (v_send.exclude_sent_send_ids)
            AND esl.sent_at IS NOT NULL
            AND lower(esl.recipient_email) = lower(s.email)
        )
      )
      AND (
        v_send.category_list_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.list_subscriptions ls2
          WHERE ls2.list_id = v_send.category_list_id
            AND ls2.subscribed = true
            AND lower(ls2.email) = lower(s.email)
        )
      )
      AND (
        v_send.include_prospects
        OR NOT EXISTS (
          SELECT 1 FROM public.people pk
          WHERE lower(pk.email) = lower(s.email)
            AND pk.contact_kind = 'prospect'
        )
      )
    ON CONFLICT (send_id, email) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM ins)::integer          AS inserted,
    (SELECT max(email) FROM slice)               AS last_email,
    ((SELECT count(*) FROM slice) = v_batch)      AS remaining;
END $function$;

-- --------------------------------------------------------------------------
-- Pre-send confirmation preview (the modal). Stays SECURITY DEFINER.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_preview_send_schedule(p_audience_type text, p_segment_id uuid, p_list_ids uuid[], p_category_list_id uuid, p_include_prospects boolean, p_scheduled_at timestamp with time zone, p_target_local text, p_default_timezone text, p_suppression_topic text DEFAULT 'broadcasts'::text)
 RETURNS TABLE(timezone text, recipients bigint, send_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_default_tz text;
  v_anchor     timestamptz := COALESCE(p_scheduled_at, now());
  v_target     text := COALESCE(NULLIF(p_target_local, ''), '09:00');
BEGIN
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(p_default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  RETURN QUERY
  WITH aud AS (
    SELECT pp.email AS email, pp.attributes AS attributes
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE p_audience_type = 'segment' AND p_segment_id IS NOT NULL
      AND sm.segment_id = p_segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    SELECT ls.email AS email, pp.attributes AS attributes
    FROM public.list_subscriptions ls
    LEFT JOIN LATERAL (
      SELECT attributes FROM public.people WHERE lower(email) = lower(ls.email) LIMIT 1
    ) pp ON true
    WHERE p_audience_type = 'list' AND COALESCE(array_length(p_list_ids, 1), 0) > 0
      AND ls.list_id = ANY (p_list_ids)
      AND ls.subscribed = true
      AND ls.email IS NOT NULL AND ls.email <> ''
  ),
  elig AS (
    SELECT DISTINCT ON (lower(a.email)) lower(a.email) AS email_lc, a.attributes
    FROM aud a
    WHERE NOT EXISTS (
        SELECT 1 FROM public.broadcast_suppressions s
        WHERE lower(s.email) = lower(a.email) AND (s.topic = p_suppression_topic OR s.topic = 'all')
      )
      AND (
        p_category_list_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.list_subscriptions ls2
          WHERE ls2.list_id = p_category_list_id AND ls2.subscribed = true
            AND lower(ls2.email) = lower(a.email)
        )
      )
      AND (
        p_include_prospects
        OR NOT EXISTS (
          SELECT 1 FROM public.people pk WHERE lower(pk.email) = lower(a.email) AND pk.contact_kind = 'prospect'
        )
      )
    ORDER BY lower(a.email)
  )
  SELECT
    COALESCE(rtz.name, v_default_tz) AS timezone,
    count(*)::bigint                 AS recipients,
    public.gw_tz_local_send_at(v_anchor, v_target, COALESCE(rtz.name, v_default_tz)) AS send_at
  FROM elig
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(elig.attributes->>'timezone', '')
  GROUP BY 1, 3
  ORDER BY 3, 1;
END $function$;
