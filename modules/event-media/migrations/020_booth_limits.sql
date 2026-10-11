-- How long the booth stays open, and how many goes each guest gets.
--
-- Every picture the booth makes costs money at a GPU endpoint, and a QR
-- code photographed by a hundred guests does not stop existing when the
-- party does -- guests carried on using it at home for days, which was
-- charming for a while and is not free (asked 2026-09-28).
--
-- Both are off until an organiser sets them, so nothing changes for an
-- event that does not.

ALTER TABLE public.events_media_booth_settings
  ADD COLUMN IF NOT EXISTS booth_closes_hours integer,
  ADD COLUMN IF NOT EXISTS booth_max_per_guest integer;

COMMENT ON COLUMN public.events_media_booth_settings.booth_closes_hours IS
  'The booth stops making pictures this many hours after the event starts. Null = no closing time.';
COMMENT ON COLUMN public.events_media_booth_settings.booth_max_per_guest IS
  'How many pictures the booth will make for one guest. Null = no limit.';

-- Sanity, not policy: an organiser can set any number they like inside
-- these, and a typo cannot leave the booth open for a year.
ALTER TABLE public.events_media_booth_settings
  DROP CONSTRAINT IF EXISTS events_media_booth_settings_closes_hours_check;
ALTER TABLE public.events_media_booth_settings
  ADD CONSTRAINT events_media_booth_settings_closes_hours_check
  CHECK (booth_closes_hours IS NULL OR (booth_closes_hours > 0 AND booth_closes_hours <= 2160));

ALTER TABLE public.events_media_booth_settings
  DROP CONSTRAINT IF EXISTS events_media_booth_settings_max_per_guest_check;
ALTER TABLE public.events_media_booth_settings
  ADD CONSTRAINT events_media_booth_settings_max_per_guest_check
  CHECK (booth_max_per_guest IS NULL OR (booth_max_per_guest > 0 AND booth_max_per_guest <= 500));
