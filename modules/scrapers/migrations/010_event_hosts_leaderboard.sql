-- Leaderboard view for event hosts. Computes every metric on the fly so there's
-- no denormalised cache to keep fresh — scrapers just upsert event_host_events
-- and the view stays correct.
--
-- Credit model: position 1 = 1.0, position 2 = 0.5, position 3 = 0.33, etc.
-- (harmonic 1/position). Unknown position is treated as 1 for back-compat.
-- weighted_score = sum(credit * guest_count). Primary city = city with the
-- most events for this host (ties broken by alphabetical, which is fine — the
-- user just wants "where do they usually operate").

CREATE OR REPLACE VIEW event_hosts_leaderboard AS
WITH host_events AS (
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
    ehe.gatewaze_event_id,
    ehe.host_position,
    COALESCE(ehe.guest_count, e.luma_guest_count, 0) AS guest_count,
    -- 1/position credit, defaulting to 1 when position unknown (legacy rows).
    1.0 / GREATEST(COALESCE(ehe.host_position, 1), 1) AS credit,
    e.event_city,
    e.event_country_code,
    e.event_start
  FROM event_hosts eh
  LEFT JOIN event_host_events ehe ON ehe.host_id = eh.id
  LEFT JOIN events e ON e.id = ehe.gatewaze_event_id
),
primary_city AS (
  SELECT DISTINCT ON (host_id)
    host_id,
    event_city AS primary_city,
    event_country_code AS primary_country_code,
    COUNT(*) OVER (PARTITION BY host_id, event_city) AS primary_city_events
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
  COUNT(DISTINCT ehe.gatewaze_event_id) FILTER (WHERE ehe.gatewaze_event_id IS NOT NULL) AS events_count,
  COUNT(DISTINCT ehe.gatewaze_event_id) FILTER (WHERE ehe.host_position = 1) AS primary_events_count,
  COALESCE(SUM(COALESCE(ehe.guest_count, e.luma_guest_count, 0)), 0)::INTEGER AS total_guests,
  COALESCE(
    SUM(
      (1.0 / GREATEST(COALESCE(ehe.host_position, 1), 1))
      * COALESCE(ehe.guest_count, e.luma_guest_count, 0)
    ),
    0
  )::INTEGER AS weighted_score,
  CASE
    WHEN COUNT(e.id) FILTER (WHERE e.luma_guest_count IS NOT NULL) > 0
    THEN ROUND(AVG(e.luma_guest_count) FILTER (WHERE e.luma_guest_count IS NOT NULL))::INTEGER
    ELSE NULL
  END AS avg_event_size,
  pc.primary_city,
  pc.primary_country_code,
  MAX(e.event_start) AS most_recent_event_at
FROM event_hosts eh
LEFT JOIN event_host_events ehe ON ehe.host_id = eh.id
LEFT JOIN events e ON e.id = ehe.gatewaze_event_id
LEFT JOIN primary_city pc ON pc.host_id = eh.id
GROUP BY
  eh.id, eh.name, eh.email, eh.avatar_url, eh.luma_user_id, eh.luma_profile_url,
  eh.linkedin_url, eh.outreach_status, eh.contacted_at, eh.last_activity_at,
  pc.primary_city, pc.primary_country_code;

-- City rollup: one row per (city, outreach_status) with counts + top hosts.
-- Used by the map tab to show markers sized by active host count per city.
CREATE OR REPLACE VIEW event_hosts_by_city AS
SELECT
  primary_city AS city,
  primary_country_code AS country_code,
  outreach_status,
  COUNT(*)::INTEGER AS host_count,
  SUM(events_count)::INTEGER AS total_events,
  SUM(weighted_score)::INTEGER AS total_weighted_score
FROM event_hosts_leaderboard
WHERE primary_city IS NOT NULL
GROUP BY primary_city, primary_country_code, outreach_status;

GRANT SELECT ON event_hosts_leaderboard TO authenticated, anon, service_role;
GRANT SELECT ON event_hosts_by_city TO authenticated, anon, service_role;
