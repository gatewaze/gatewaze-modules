-- Depth of field, per album.
--
-- A phone shoots a tiny sensor at a wide angle, so everything from the
-- tablecloth to the far wall is sharp at once. Measured on 2026-10-01,
-- the guests' photographs separate their subject from the background by
-- a sharpness ratio of 0.4 to 2.0, where separating them at all starts
-- around 3. It is the loudest "taken on a phone" cue there is, and no
-- amount of tone and colour work touches it.
--
--   off      leave it as the phone saw it
--   gentle   a little separation. The default where this is on, chosen
--            by looking at all three across six photographs
--   medium   more
--   strong   a fast prime wide open, which is a look rather than a
--            correction
--
-- Nothing is invented. Two models supply measurements -- a depth map and
-- a subject mask, both already used by the booth -- and the defocus is
-- arithmetic on pixels that are already there. A photograph with no
-- subject in it is left alone rather than guessed at.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS focus text NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_media_album_settings_focus_check'
  ) THEN
    ALTER TABLE public.event_media_album_settings
      ADD CONSTRAINT event_media_album_settings_focus_check
      CHECK (focus IN ('off', 'gentle', 'medium', 'strong'));
  END IF;
END $$;

COMMENT ON COLUMN public.event_media_album_settings.focus IS
  'Depth of field for this album''s improved copies: off, gentle, medium or strong.';
