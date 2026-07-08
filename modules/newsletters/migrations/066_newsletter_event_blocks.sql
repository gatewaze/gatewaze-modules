-- Newsletter event blocks: list-returning RPCs for the Local Events (per
-- recipient, geo-filtered) and Virtual Events (global) email blocks.
--
-- These back the send-engine binding's per-recipient / per-send resolution
-- (modules/newsletters/workers/send-engine-binding.ts). They deliberately
-- mirror events.next_local_event (migration 017): same visibility gate
-- (publish_state = 'published' — is_live_in_production is generated from it),
-- same inline haversine (no PostGIS/earthdistance dep), same public-view
-- SECURITY DEFINER posture. The difference: they return a LIST (LIMIT p_limit),
-- not just the single soonest event, and split in-person vs virtual.
--
-- v1 scope: "local" = within p_radius_km of the recipient's coords, else same
-- city (region/country tiers intentionally dropped — too broad for a "near you"
-- block). "Same US state" matching is NOT included in v1 (events carry no state
-- column). Virtual events are matched by the 'Online' city / 'on' region
-- convention (there is no is_virtual flag on events).

-- ── newsletter_local_events ─────────────────────────────────────────────────
-- Upcoming in-person events near a recipient. Cascade, first non-empty tier
-- wins: (1) geo-radius around the recipient's coords, (2) same city.
CREATE OR REPLACE FUNCTION public.newsletter_local_events(
  p_lat       double precision DEFAULT NULL,
  p_lon       double precision DEFAULT NULL,
  p_city      text DEFAULT NULL,
  p_after     timestamptz DEFAULT now(),
  p_radius_km double precision DEFAULT 100,
  p_limit     integer DEFAULT 3
)
RETURNS TABLE (
  id             uuid,
  event_id       text,
  event_title    text,
  event_start    timestamptz,
  event_timezone text,
  event_city     text,
  event_slug     text,
  event_url      text,
  event_image    text,
  match_tier     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 3), 20));
BEGIN
  -- Tier 1: geo-radius (haversine, km). Soonest upcoming, non-virtual.
  IF p_lat IS NOT NULL AND p_lon IS NOT NULL THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'geo'::text
      FROM public.events e
      WHERE e.publish_state = 'published'
        AND e.event_start > p_after
        AND e.event_latitude IS NOT NULL AND e.event_longitude IS NOT NULL
        AND (e.event_city IS NULL OR e.event_city NOT ILIKE 'Online')
        AND (e.event_region IS NULL OR e.event_region NOT IN ('on', 'Online'))
        AND (6371 * acos(LEAST(1, GREATEST(-1,
              cos(radians(p_lat)) * cos(radians(e.event_latitude)) *
              cos(radians(e.event_longitude) - radians(p_lon)) +
              sin(radians(p_lat)) * sin(radians(e.event_latitude)))))) <= p_radius_km
      ORDER BY e.event_start ASC
      LIMIT v_limit;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Tier 2: same city (fallback when the recipient has no coords, or no event
  -- fell inside the radius).
  IF p_city IS NOT NULL AND p_city <> '' AND p_city NOT ILIKE 'Online' THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'city'::text
      FROM public.events e
      WHERE e.publish_state = 'published'
        AND e.event_start > p_after
        AND e.event_city ILIKE p_city
      ORDER BY e.event_start ASC
      LIMIT v_limit;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN; -- no match: caller omits the block for this recipient
END;
$$;

COMMENT ON FUNCTION public.newsletter_local_events(double precision, double precision, text, timestamptz, double precision, integer) IS
  'Upcoming in-person events near a recipient: geo-radius then same-city cascade, up to p_limit. Backs the Local Events newsletter block.';

-- ── newsletter_virtual_events ───────────────────────────────────────────────
-- Upcoming virtual/online events (global — same for every recipient in a send).
-- Matched by the 'Online' city / 'on' region convention (no is_virtual flag).
CREATE OR REPLACE FUNCTION public.newsletter_virtual_events(
  p_after timestamptz DEFAULT now(),
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  id             uuid,
  event_id       text,
  event_title    text,
  event_start    timestamptz,
  event_timezone text,
  event_city     text,
  event_slug     text,
  event_url      text,
  event_image    text,
  match_tier     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 5), 20));
BEGIN
  RETURN QUERY
    SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
           e.event_timezone::text, e.event_city::text, e.event_slug::text,
           e.event_source_url::text, e.event_featured_image::text, 'virtual'::text
    FROM public.events e
    WHERE e.publish_state = 'published'
      AND e.event_start > p_after
      AND (e.event_city ILIKE 'Online' OR e.event_region IN ('on', 'Online'))
    ORDER BY e.event_start ASC
    LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.newsletter_virtual_events(timestamptz, integer) IS
  'Upcoming virtual/online events (global). Backs the Virtual Events newsletter block.';

-- Visibility-safe: aggregate/public-view functions, not row access. Keep them
-- off PUBLIC/anon; the send worker runs as service_role, the editor preview as
-- authenticated.
REVOKE ALL ON FUNCTION public.newsletter_local_events(double precision, double precision, text, timestamptz, double precision, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletter_virtual_events(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletter_local_events(double precision, double precision, text, timestamptz, double precision, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.newsletter_virtual_events(timestamptz, integer) TO authenticated, service_role;
