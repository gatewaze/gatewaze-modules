-- next_local_event: find a recipient's next nearby published event.
-- Spec: spec-newsletter-personalised-delivery.md §B.2 (next-local-event provider).
--
-- Cascade, first hit wins: (1) geo-radius around the recipient's coords,
-- (2) same city, (3) same region, (4) same country. Only future, published,
-- publicly-visible events. SECURITY DEFINER so the send/dispatch path (service
-- role already, but keep it visibility-safe) gets a consistent public view.

CREATE OR REPLACE FUNCTION public.next_local_event(
  p_lat       double precision DEFAULT NULL,
  p_lon       double precision DEFAULT NULL,
  p_city      text DEFAULT NULL,
  p_region    text DEFAULT NULL,
  p_country   text DEFAULT NULL,
  p_after     timestamptz DEFAULT now(),
  p_radius_km double precision DEFAULT 100
)
RETURNS TABLE (
  id            uuid,
  event_id      text,
  event_title   text,
  event_start   timestamptz,
  event_timezone text,
  event_city    text,
  event_slug    text,
  event_url     text,
  event_image   text,
  match_tier    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Tier 1: geo-radius (haversine, km). Soonest upcoming within radius.
  IF p_lat IS NOT NULL AND p_lon IS NOT NULL THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'geo'::text
      FROM public.events e
      WHERE e.publish_state = 'published'
        AND e.event_start > p_after
        AND e.event_latitude IS NOT NULL AND e.event_longitude IS NOT NULL
        AND (6371 * acos(LEAST(1, GREATEST(-1,
              cos(radians(p_lat)) * cos(radians(e.event_latitude)) *
              cos(radians(e.event_longitude) - radians(p_lon)) +
              sin(radians(p_lat)) * sin(radians(e.event_latitude)))))) <= p_radius_km
      ORDER BY e.event_start ASC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Tier 2: same city.
  IF p_city IS NOT NULL AND p_city <> '' THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'city'::text
      FROM public.events e
      WHERE e.publish_state = 'published' AND e.event_start > p_after
        AND e.event_city ILIKE p_city
      ORDER BY e.event_start ASC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Tier 3: same region.
  IF p_region IS NOT NULL AND p_region <> '' THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'region'::text
      FROM public.events e
      WHERE e.publish_state = 'published' AND e.event_start > p_after
        AND e.event_region = p_region
      ORDER BY e.event_start ASC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Tier 4: same country.
  IF p_country IS NOT NULL AND p_country <> '' THEN
    RETURN QUERY
      SELECT e.id, e.event_id::text, e.event_title::text, e.event_start,
             e.event_timezone::text, e.event_city::text, e.event_slug::text,
             e.event_source_url::text, e.event_featured_image::text, 'country'::text
      FROM public.events e
      WHERE e.publish_state = 'published' AND e.event_start > p_after
        AND e.event_country_code = upper(p_country)
      ORDER BY e.event_start ASC
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN; -- no match: caller omits the block
END;
$$;

COMMENT ON FUNCTION public.next_local_event(double precision, double precision, text, text, text, timestamptz, double precision) IS
  'Next upcoming published event near a recipient: cascade geo-radius -> city -> region -> country (spec-newsletter-personalised-delivery B.2).';
