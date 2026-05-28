-- ============================================================================
-- event_hosts_leaderboard — date-range function variant
--
-- The existing view computes scores across ALL events. This adds a function
-- form `event_hosts_leaderboard_fn(p_from, p_to)` that limits the per-event
-- aggregation to events whose `event_start` falls inside the range, so the
-- League Table can answer "who's been most active in the last 6 months".
--
-- Both NULL bounds = same result as the all-time view. Hosts with zero
-- events inside the range are filtered out (no point ranking inactive
-- hosts when the whole point of the filter is "who's hosting now").
-- ============================================================================

CREATE OR REPLACE FUNCTION public.event_hosts_leaderboard_fn(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(
  host_id              uuid,
  name                 text,
  email                text,
  avatar_url           text,
  luma_user_id         text,
  luma_profile_url     text,
  linkedin_url         text,
  outreach_status      text,
  contacted_at         timestamptz,
  last_activity_at     timestamptz,
  events_count         bigint,
  primary_events_count bigint,
  total_guests         integer,
  weighted_score       integer,
  avg_event_size       integer,
  primary_city         text,
  primary_country_code text,
  most_recent_event_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH host_events AS (
    SELECT
      eh.id AS host_id,
      ehe.gatewaze_event_id,
      ehe.host_position,
      COALESCE(ehe.guest_count, e.luma_guest_count, 0) AS guest_count,
      e.event_city,
      e.event_country_code,
      e.event_start,
      e.luma_guest_count
    FROM public.event_hosts eh
    LEFT JOIN public.event_host_events ehe ON ehe.host_id = eh.id
    LEFT JOIN public.events e ON e.id = ehe.gatewaze_event_id
    WHERE
      -- Apply the date filter on the EVENT timestamp. NULL bounds ⇒ all-time.
      -- LEFT JOIN means hosts with no events still match (event_start IS NULL).
      (p_from IS NULL OR e.event_start IS NULL OR e.event_start >= p_from)
      AND (p_to IS NULL OR e.event_start IS NULL OR e.event_start < p_to)
  ),
  primary_city AS (
    SELECT DISTINCT ON (host_id)
      host_id,
      event_city AS primary_city,
      event_country_code AS primary_country_code
    FROM host_events
    WHERE event_city IS NOT NULL AND event_city <> ''
    ORDER BY host_id, COUNT(*) OVER (PARTITION BY host_id, event_city) DESC, event_city
  )
  SELECT
    eh.id AS host_id,
    eh.name,
    eh.email,
    eh.avatar_url,
    eh.luma_user_id,
    eh.luma_profile_url,
    eh.linkedin_url,
    eh.outreach_status,
    eh.contacted_at,
    eh.last_activity_at,
    COUNT(DISTINCT he.gatewaze_event_id) FILTER (WHERE he.gatewaze_event_id IS NOT NULL) AS events_count,
    COUNT(DISTINCT he.gatewaze_event_id) FILTER (WHERE he.host_position = 1) AS primary_events_count,
    COALESCE(SUM(he.guest_count), 0)::INTEGER AS total_guests,
    COALESCE(
      SUM((1.0 / GREATEST(COALESCE(he.host_position, 1), 1)) * he.guest_count),
      0
    )::INTEGER AS weighted_score,
    CASE
      WHEN COUNT(*) FILTER (WHERE he.luma_guest_count IS NOT NULL) > 0
      THEN ROUND(AVG(he.luma_guest_count) FILTER (WHERE he.luma_guest_count IS NOT NULL))::INTEGER
      ELSE NULL
    END AS avg_event_size,
    pc.primary_city,
    pc.primary_country_code,
    MAX(he.event_start) AS most_recent_event_at
  FROM public.event_hosts eh
  LEFT JOIN host_events he ON he.host_id = eh.id
  LEFT JOIN primary_city pc ON pc.host_id = eh.id
  -- When a date filter IS applied, drop hosts with zero in-range events.
  -- All-time call (both bounds NULL) keeps everyone, matching the view.
  WHERE (p_from IS NULL AND p_to IS NULL)
     OR EXISTS (
       SELECT 1 FROM host_events he2
       WHERE he2.host_id = eh.id AND he2.gatewaze_event_id IS NOT NULL
     )
  GROUP BY
    eh.id, eh.name, eh.email, eh.avatar_url, eh.luma_user_id, eh.luma_profile_url,
    eh.linkedin_url, eh.outreach_status, eh.contacted_at, eh.last_activity_at,
    pc.primary_city, pc.primary_country_code;
$$;

REVOKE ALL ON FUNCTION public.event_hosts_leaderboard_fn(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_hosts_leaderboard_fn(timestamptz, timestamptz)
  TO authenticated, anon, service_role;
