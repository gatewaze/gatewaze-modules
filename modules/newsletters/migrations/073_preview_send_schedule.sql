-- ============================================================================
-- Module: newsletters
-- Migration: 073_preview_send_schedule
-- Description: Pre-send preview of per-timezone delivery times, so the Sending
-- UI can show a confirmation ("who receives when") BEFORE a scheduled send is
-- created — making an all-at-once blast obvious up front.
--
-- Uses the EXACT same send_at formula as the fanout (072):
--   send_at(tz) = GREATEST(scheduled_at, target_local on the schedule date in tz)
-- grouped by the recipient's resolved timezone. Read-only; no send row needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletter_preview_send_schedule(
  p_list_id          uuid,
  p_scheduled_at     timestamptz,
  p_target_local     text,
  p_default_timezone text
)
RETURNS TABLE(timezone text, recipients bigint, send_at timestamptz)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_default_tz    text;
  v_schedule_date date;
  v_target        text := COALESCE(NULLIF(p_target_local, ''), '09:00');
BEGIN
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(p_default_timezone, '') LIMIT 1;
  v_default_tz    := COALESCE(v_default_tz, 'UTC');
  v_schedule_date := (p_scheduled_at AT TIME ZONE v_default_tz)::date;

  RETURN QUERY
  SELECT
    tzn.name,
    count(*)::bigint,
    GREATEST(
      p_scheduled_at,
      ((v_schedule_date::text || ' ' || v_target)::timestamp AT TIME ZONE tzn.name)
    )
  -- Join people by person_id (PK) rather than a per-row lower(email) lookup —
  -- the email lateral made this ~20-30s (over the 8s RPC cap); the PK join is
  -- ~3s. Coverage is near-total; the rare null-person_id subscriber falls back
  -- to the default timezone (same as an unresolved recipient).
  FROM public.list_subscriptions ls
  LEFT JOIN public.people p ON p.id = ls.person_id
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(p.attributes->>'timezone', '')
  CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, v_default_tz) AS name) tzn
  WHERE ls.list_id = p_list_id AND ls.subscribed = true
  GROUP BY tzn.name
  ORDER BY 3, 1;
END $function$;

GRANT EXECUTE ON FUNCTION public.newsletter_preview_send_schedule(uuid, timestamptz, text, text)
  TO authenticated, service_role;
