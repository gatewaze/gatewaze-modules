-- ============================================================================
-- Module: broadcasts
-- Migration: 020_preview_send_schedule
-- Description: Pre-send per-timezone delivery preview for broadcasts, so the
-- shared SendingPanel confirmation ("who receives when", list + world map) works
-- for broadcasts too. Resolves the deliverable audience exactly like
-- broadcast_recipient_preview_count / fanout_broadcast_send_recipients_batch
-- (segment or list, minus suppressions / prior-sends / prospects, intersected
-- with the category list) and returns, per recipient timezone, the send_at from
-- the same clamp formula: GREATEST(scheduled_at, target_local on schedule date).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_preview_send_schedule(
  p_audience_type     text,
  p_segment_id        uuid,
  p_list_ids          uuid[],
  p_category_list_id  uuid,
  p_include_prospects boolean,
  p_scheduled_at      timestamptz,
  p_target_local      text,
  p_default_timezone  text,
  p_suppression_topic text DEFAULT 'broadcasts'
)
RETURNS TABLE(timezone text, recipients bigint, send_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_tz    text;
  v_schedule_date date;
  v_anchor        timestamptz := COALESCE(p_scheduled_at, now());
  v_target        text := COALESCE(NULLIF(p_target_local, ''), '09:00');
BEGIN
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(p_default_timezone, '') LIMIT 1;
  v_default_tz    := COALESCE(v_default_tz, 'UTC');
  v_schedule_date := (v_anchor AT TIME ZONE v_default_tz)::date;

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
    GREATEST(
      v_anchor,
      ((v_schedule_date::text || ' ' || v_target)::timestamp AT TIME ZONE COALESCE(rtz.name, v_default_tz))
    )                                AS send_at
  FROM elig
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(elig.attributes->>'timezone', '')
  GROUP BY 1, 3
  ORDER BY 3, 1;
END $$;

GRANT EXECUTE ON FUNCTION public.broadcast_preview_send_schedule(text, uuid, uuid[], uuid, boolean, timestamptz, text, text, text)
  TO authenticated, service_role;
