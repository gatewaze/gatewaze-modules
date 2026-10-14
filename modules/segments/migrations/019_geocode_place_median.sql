-- ============================================================================
-- Module: segments
-- Migration: 019_geocode_place_median
-- Description: segments_geocode_place resolved a place to the AVERAGE of its
-- contacts' IP-derived coordinates. IP geolocation is noisy and a handful of
-- far-off points drag an average a long way: on tech.tickets "San Francisco"
-- (788 contacts, 666 of them in the city) resolved to 37.728,-120.143, about
-- 200 km east near Yosemite, so a "within N km of San Francisco" audience was
-- centred in the wrong place. The median of the same contacts is
-- 37.775,-122.419, the city itself. Same function, median instead of mean,
-- for both the contacts and the events-venue fallback.
--
-- Conditions already saved keep the centre they stored; re-entering the place
-- in the audience builder re-geocodes it.
-- ============================================================================
SET LOCAL check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.segments_geocode_place(p_place text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_place text := NULLIF(trim(p_place), '');
  v_lat float8; v_lng float8; v_n int;
BEGIN
  IF v_place IS NULL THEN RETURN NULL; END IF;

  -- 1) Median of contacts whose city or state matches, with parseable coords.
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY split_part(attributes->>'location', ',', 1)::float8),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY split_part(attributes->>'location', ',', 2)::float8),
         count(*)
    INTO v_lat, v_lng, v_n
  FROM public.people
  WHERE attributes->>'location' ~ '^-?[0-9.]+,-?[0-9.]+$'
    AND (attributes->>'city' ILIKE v_place OR attributes->>'state' ILIKE v_place);
  IF COALESCE(v_n, 0) > 0 THEN
    RETURN jsonb_build_object('lat', v_lat, 'lng', v_lng, 'n', v_n, 'source', 'contacts');
  END IF;

  -- 2) Fallback: median venue coordinates of events in that city. Guarded so a
  --    brand whose events table lacks lat/lng columns still creates + runs.
  BEGIN
    EXECUTE $q$
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY event_latitude::float8),
             percentile_cont(0.5) WITHIN GROUP (ORDER BY event_longitude::float8),
             count(*)
      FROM public.events
      WHERE event_latitude IS NOT NULL AND event_longitude IS NOT NULL
        AND event_city ILIKE $1
    $q$ INTO v_lat, v_lng, v_n USING v_place;
    IF COALESCE(v_n, 0) > 0 THEN
      RETURN jsonb_build_object('lat', v_lat, 'lng', v_lng, 'n', v_n, 'source', 'events');
    END IF;
  EXCEPTION WHEN others THEN
    NULL;  -- no usable events coordinates on this brand
  END;

  RETURN NULL;
END $$;

GRANT EXECUTE ON FUNCTION public.segments_geocode_place(text) TO authenticated, service_role;
