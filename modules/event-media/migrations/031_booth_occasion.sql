-- Which occasions the photo booth celebrates, beside the decades.
--
-- 'none' (the default) is the booth as it was. Naming one occasion --
-- 'halloween', say -- adds that occasion's look to every decade's board
-- (a 50s Halloween, a 70s Halloween); 'all' adds every occasion's. The
-- occasions and their looks are defined in code (lib/booth-occasions.ts,
-- lib/booth-effects.ts); this only records the choice, and the check
-- keeps the column to a key shape rather than a list of keys so that
-- the code is the one place that says what exists.

ALTER TABLE public.events_media_booth_settings
  ADD COLUMN IF NOT EXISTS occasion text NOT NULL DEFAULT 'none';

ALTER TABLE public.events_media_booth_settings
  DROP CONSTRAINT IF EXISTS events_media_booth_settings_occasion_check;
ALTER TABLE public.events_media_booth_settings
  ADD CONSTRAINT events_media_booth_settings_occasion_check
  CHECK (occasion ~ '^(none|all|[a-z]{3,24})$');

COMMENT ON COLUMN public.events_media_booth_settings.occasion IS
  'none, all, or one occasion key such as halloween: adds that occasion''s look to every decade''s board.';
