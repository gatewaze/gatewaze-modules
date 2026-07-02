-- ============================================================================
-- Module: segments
-- Migration: 008_geo_radius
-- Description: Radius / surrounding-area targeting. Many contacts carry a
-- "lat,lng" string in people.attributes.location (populated from IP geo). This
-- adds a `geo_radius` condition source: "within N km of <place>". The place is
-- geocoded server-side from our OWN data (centroid of contacts in that
-- city/state, with an events-venue fallback) — no external geocoder — and the
-- resolved lat/lng are stored on the condition; the predicate is a haversine
-- distance over each person's own coordinates. Contacts without coordinates
-- simply don't match.
-- ============================================================================
SET LOCAL check_function_bodies = off;

-- Geocode a place name to a lat/lng centroid from our own data. Returns
-- {lat, lng, n, source} or NULL when we have no coordinates for that place.
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

  -- 1) Centroid of contacts whose city or state matches, with parseable coords.
  SELECT avg(split_part(attributes->>'location', ',', 1)::float8),
         avg(split_part(attributes->>'location', ',', 2)::float8),
         count(*)
    INTO v_lat, v_lng, v_n
  FROM public.people
  WHERE attributes->>'location' ~ '^-?[0-9.]+,-?[0-9.]+$'
    AND (attributes->>'city' ILIKE v_place OR attributes->>'state' ILIKE v_place);
  IF COALESCE(v_n, 0) > 0 THEN
    RETURN jsonb_build_object('lat', v_lat, 'lng', v_lng, 'n', v_n, 'source', 'contacts');
  END IF;

  -- 2) Fallback: average venue coordinates of events in that city. Guarded so a
  --    brand whose events table lacks lat/lng columns still creates + runs.
  BEGIN
    EXECUTE $q$
      SELECT avg(event_latitude::float8), avg(event_longitude::float8), count(*)
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

-- Predicate: person is within radius_km of (lat,lng), by haversine over their
-- own attributes.location "lat,lng". No PostGIS dependency.
CREATE OR REPLACE FUNCTION public.segments_geo_radius_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_lat    float8 := NULLIF(cond->>'lat', '')::float8;
  v_lng    float8 := NULLIF(cond->>'lng', '')::float8;
  v_radius float8 := NULLIF(cond->>'radius_km', '')::float8;
  v_op     text   := COALESCE(cond->>'operator', 'within');
  v_loc    text   := '(p.attributes->>''location'')';
  v_plat   text;
  v_plng   text;
  v_dist   text;
  v_pred   text;
BEGIN
  -- Missing/unresolved coordinates → matches nobody (the copilot/UI warns).
  IF v_lat IS NULL OR v_lng IS NULL OR v_radius IS NULL THEN
    RETURN CASE WHEN v_op = 'not_within' THEN 'true' ELSE 'false' END;
  END IF;

  v_plat := format('split_part(%s, '','', 1)::float8', v_loc);
  v_plng := format('split_part(%s, '','', 2)::float8', v_loc);
  -- Great-circle distance in km (clamped acos argument to [-1,1] for safety).
  v_dist := format(
    '6371 * acos(least(1, greatest(-1, cos(radians(%s)) * cos(radians(%s)) * cos(radians(%s) - radians(%s)) + sin(radians(%s)) * sin(radians(%s)))))',
    v_lat, v_plat, v_plng, v_lng, v_lat, v_plat);
  v_pred := format('(%s ~ ''^-?[0-9.]+,-?[0-9.]+$'' AND %s <= %s)', v_loc, v_dist, v_radius);

  RETURN CASE WHEN v_op = 'not_within' THEN 'NOT ' || v_pred ELSE v_pred END;
END $$;

-- Register in the condition-source registry so the builder catalogue + the AI
-- copilot pick it up. lat/lng are filled server-side after geocoding `place`,
-- so they're intentionally NOT in params_schema (the model supplies place +
-- radius_km only).
INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES ('geo_radius', 'segments', 'Geographic radius', 'segments_geo_radius_to_sql', NULL,
  jsonb_build_object('type', 'object', 'required', jsonb_build_array('place', 'radius_km'),
    'properties', jsonb_build_object(
      'place', jsonb_build_object('type', 'string'),
      'radius_km', jsonb_build_object('type', 'number'))),
  ARRAY['within', 'not_within'], 10)
ON CONFLICT (kind) DO UPDATE SET predicate_fn = EXCLUDED.predicate_fn, params_schema = EXCLUDED.params_schema, operators = EXCLUDED.operators, label = EXCLUDED.label;
