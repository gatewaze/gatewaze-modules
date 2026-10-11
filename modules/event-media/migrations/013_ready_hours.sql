-- How long before an event the "getting ready" section opens.
--
-- Default a day and a half, which covers the night before and the
-- morning itself. Adjustable so an organiser can open it earlier -- for
-- guests travelling, or to try it out before the day.

ALTER TABLE public.events_media_booth_settings
  ADD COLUMN IF NOT EXISTS ready_hours integer NOT NULL DEFAULT 36
    CHECK (ready_hours BETWEEN 0 AND 336);

COMMENT ON COLUMN public.events_media_booth_settings.ready_hours IS
  'Hours before the event start that the getting-ready prompts appear; 0 turns them off.';
