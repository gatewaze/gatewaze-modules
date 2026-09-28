-- When the evening reception starts, per event.
--
-- Half past six was a guess, and a good default, but not every wedding
-- is the same shape: this one's reception had clearly started by five,
-- and eight photographs sat in The day that everybody thinks of as the
-- evening (reported 2026-09-28). So the organiser says.
--
-- Minutes past midnight, in the same clock everything else here uses --
-- the one on the camera and the one the event's start is stored in.
-- Null means half past six.
--
-- It lives on the booth settings table because that is already where an
-- event's media settings are kept (ready_hours is there too, and is no
-- more about the booth than this is). Worth splitting one day; not worth
-- a migration of its own today.

ALTER TABLE public.events_media_booth_settings
  ADD COLUMN IF NOT EXISTS evening_from_minutes integer;

COMMENT ON COLUMN public.events_media_booth_settings.evening_from_minutes IS
  'When the evening reception starts, minutes past midnight. Null = 18:30.';

ALTER TABLE public.events_media_booth_settings
  DROP CONSTRAINT IF EXISTS events_media_booth_settings_evening_from_check;
ALTER TABLE public.events_media_booth_settings
  ADD CONSTRAINT events_media_booth_settings_evening_from_check
  CHECK (evening_from_minutes IS NULL OR (evening_from_minutes >= 0 AND evening_from_minutes < 1440));
