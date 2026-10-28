-- =====================================================================
-- Module: calendars
-- Migration: 017_calendar_location_autofill
-- =====================================================================
-- A calendar's location lives in settings.location (the CalendarLocation
-- shape the admin Settings tab edits and calendars-process-csv reads). Until
-- now only an admin could set it, so the ~70 auto-discovered AAIF chapter
-- calendars have none. This adds the two functions the scraper worker uses
-- to fill it in, and backfills what the calendars' events can already tell us.
--
-- Two automatic sources, in order of trust:
--   'luma'   - the Luma calendar's own location (worker reads it from the
--              calendar page's __NEXT_DATA__, alongside the cover image).
--   'events' - the city most of the calendar's events are in, used when the
--              Luma page has no location (or the calendar is not on Luma).
-- An admin edit is stored with source 'manual' and is never overwritten.
--
-- A location written before this migration has no source. One with only
-- {type:'global'} is treated as unset: the Settings form saved exactly that
-- by default on every save, so it does not mean someone chose "global". Any
-- other source-less location was typed in by an admin and counts as manual.
-- =====================================================================

-- Can an automatic source of kind p_source replace this location?
CREATE OR REPLACE FUNCTION public.calendars_location_is_auto_writable(p_location jsonb, p_source text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_location IS NULL OR jsonb_typeof(p_location) <> 'object' THEN true
    WHEN p_location->>'source' = 'manual' THEN false
    WHEN p_location->>'source' = 'events' THEN true
    WHEN p_location->>'source' = 'luma' THEN p_source = 'luma'
    WHEN p_location ? 'source' THEN false
    -- Legacy, no source: only the form's default {type:'global'} is unset.
    ELSE coalesce(p_location->>'type', 'global') = 'global'
         AND nullif(btrim(coalesce(p_location->>'city', '')), '') IS NULL
         AND nullif(btrim(coalesce(p_location->>'state', '')), '') IS NULL
         AND nullif(btrim(coalesce(p_location->>'country', '')), '') IS NULL
         AND nullif(btrim(coalesce(p_location->>'country_code', '')), '') IS NULL
  END;
$$;

-- Write an automatically derived location onto one calendar, if allowed.
-- Only the known CalendarLocation keys are copied, and each is validated, so
-- a caller cannot write arbitrary JSON into settings. Returns true when the
-- row changed.
CREATE OR REPLACE FUNCTION public.calendars_apply_auto_location(
  p_calendar_id uuid,
  p_location jsonb,
  p_source text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_city text := nullif(btrim(left(p_location->>'city', 100)), '');
  v_state text := nullif(btrim(left(p_location->>'state', 100)), '');
  v_country text := nullif(btrim(left(p_location->>'country', 100)), '');
  v_cc text := upper(nullif(btrim(p_location->>'country_code'), ''));
  v_lat double precision;
  v_lng double precision;
  v_loc jsonb;
  v_rows integer;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('luma', 'events') THEN
    RAISE EXCEPTION 'calendars_apply_auto_location: invalid source %', p_source;
  END IF;
  IF p_calendar_id IS NULL OR p_location IS NULL OR jsonb_typeof(p_location) <> 'object' THEN
    RETURN false;
  END IF;

  IF v_cc IS NOT NULL AND v_cc !~ '^[A-Z]{2}$' THEN
    v_cc := NULL;
  END IF;
  IF jsonb_typeof(p_location->'latitude') = 'number' AND jsonb_typeof(p_location->'longitude') = 'number' THEN
    v_lat := (p_location->>'latitude')::double precision;
    v_lng := (p_location->>'longitude')::double precision;
    IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 THEN
      v_lat := NULL;
      v_lng := NULL;
    END IF;
  END IF;

  -- Nothing a map could place: leave the calendar alone.
  IF v_city IS NULL AND v_country IS NULL AND v_cc IS NULL THEN
    RETURN false;
  END IF;

  v_loc := jsonb_strip_nulls(jsonb_build_object(
    'type', CASE WHEN v_city IS NOT NULL THEN 'city' ELSE 'country' END,
    'city', v_city,
    'state', v_state,
    'country', v_country,
    'country_code', v_cc,
    'latitude', v_lat,
    'longitude', v_lng,
    'source', p_source
  ));

  UPDATE public.calendars c
     SET settings = jsonb_set(coalesce(c.settings, '{}'::jsonb), '{location}', v_loc)
   WHERE c.id = p_calendar_id
     AND public.calendars_location_is_auto_writable(c.settings->'location', p_source)
     AND c.settings->'location' IS DISTINCT FROM v_loc;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- The location most of a calendar's events share, or NULL when there is no
-- clear majority of its in-person events. A majority is required so a global
-- calendar that happens to hold a few events in one city is not pinned to
-- that city. Virtual events are not counted at all. Coordinates are
-- the mean of the majority city's events (events.event_location is "lat,lng").
CREATE OR REPLACE FUNCTION public.calendars_location_from_events(p_calendar_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- The coordinate pattern is bounded so an oversized digit string from a
  -- scraped page cannot overflow the cast and abort the whole backfill.
  WITH located AS (
    SELECT btrim(e.event_city) AS city,
           upper(nullif(btrim(e.event_country_code), '')) AS cc,
           CASE WHEN e.event_location ~ '^\s*-?[0-9]{1,3}(\.[0-9]{1,20})?\s*,\s*-?[0-9]{1,3}(\.[0-9]{1,20})?\s*$'
                THEN split_part(e.event_location, ',', 1)::double precision END AS lat,
           CASE WHEN e.event_location ~ '^\s*-?[0-9]{1,3}(\.[0-9]{1,20})?\s*,\s*-?[0-9]{1,3}(\.[0-9]{1,20})?\s*$'
                THEN split_part(e.event_location, ',', 2)::double precision END AS lng
      FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
     WHERE ce.calendar_id = p_calendar_id
       -- Published events only (the portal / public API rule): the result is
       -- served publicly, so drafts and unlisted events must not shape it.
       AND e.is_live_in_production = true
       AND e.is_listed = true
       AND nullif(btrim(e.event_city), '') IS NOT NULL
       -- 'online' is how the scrapers mark a virtual event (with the
       -- made-up country code 'ON'); it is not a place.
       AND lower(btrim(e.event_city)) NOT IN ('online', 'virtual', 'remote')
  ),
  grouped AS (
    SELECT min(city) AS city,
           cc,
           count(*) AS n,
           sum(count(*)) OVER () AS total,
           avg(lat) FILTER (WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180) AS lat,
           avg(lng) FILTER (WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180) AS lng
      FROM located
     GROUP BY lower(city), cc
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'city', city,
           'country_code', cc,
           'latitude', lat,
           'longitude', lng
         ))
    FROM grouped
   WHERE n * 2 > total
   ORDER BY n DESC
   LIMIT 1;
$$;

-- Fill one calendar (or, with NULL, every calendar) from its events. Returns
-- the number of calendars updated.
CREATE OR REPLACE FUNCTION public.calendars_autofill_location_from_events(p_calendar_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT c.id, public.calendars_location_from_events(c.id) AS loc
      FROM public.calendars c
     WHERE (p_calendar_id IS NULL OR c.id = p_calendar_id)
       AND public.calendars_location_is_auto_writable(c.settings->'location', 'events')
  LOOP
    IF r.loc IS NOT NULL AND public.calendars_apply_auto_location(r.id, r.loc, 'events') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Writers are the scraper worker (service role) and this migration. RLS
-- already blocks other roles from updating calendars; revoking EXECUTE as
-- well keeps the functions off the anon/authenticated RPC surface entirely.
REVOKE ALL ON FUNCTION public.calendars_location_is_auto_writable(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendars_apply_auto_location(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendars_location_from_events(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendars_autofill_location_from_events(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendars_location_is_auto_writable(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calendars_apply_auto_location(uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calendars_location_from_events(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.calendars_autofill_location_from_events(uuid) TO service_role;

-- Backfill from events now. The worker upgrades each calendar to its Luma
-- location the next time that calendar's scraper saves an event.
SELECT public.calendars_autofill_location_from_events(NULL);
