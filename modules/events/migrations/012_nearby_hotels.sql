-- ============================================================================
-- Migration: events_012_nearby_hotels
-- Description: Adds the nearby_hotels jsonb column on events so the venue
--              page can render a list of nearby accommodation, plotted on the
--              same Leaflet map as the venue itself.
--
-- Shape of each entry (validated at the application layer, not via CHECK so
-- we can evolve the schema without migrations) — camelCase to round-trip
-- the admin form without translation:
--   {
--     "id":                   "<short stable id, used as react key>",
--     "name":                 "Premier Inn Durham City Centre",
--     "postcode":             "DH1 4DJ",         -- UK postcode OR US zip
--     "url":                  "https://...",     -- optional
--     "priceRange":           "£70–£120/night",  -- free-form single line
--     "lat":                  54.7766,
--     "lng":                  -1.5742,
--     "geocodedAt":           "2026-05-04T12:34:56Z",
--     "driveSeconds":         720,                -- OSRM driving time (best-effort, may be null)
--     "driveDistanceMeters":  12345
--   }
--
-- Distance from the venue is computed at render time from
-- events.event_latitude / event_longitude — not denormalised, so moving the
-- venue automatically re-orders the hotel list.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS nearby_hotels jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.events.nearby_hotels IS
  'JSON array of nearby accommodation entries. Each entry: {id, name, postcode, url?, price_range?, lat, lng, geocoded_at}. Rendered on the venue page sorted ascending by distance from (event_latitude, event_longitude). Geocoding done via Nominatim at admin save time.';
