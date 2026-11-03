-- Enhancement, per album.
--
-- Some of the day's photographs are dark or flat -- phones in a marquee
-- in the evening. An organiser can turn enhancement on for an album (the
-- getting-ready and day photographs were the ones asked for, 2026-09-27)
-- and have each photograph looked at and improved: more light, more
-- contrast, a warmer cast, a little sharpening.
--
-- Nothing is redrawn. A model says what a photograph needs and the change
-- itself is arithmetic on the pixels, so no face can come back as
-- somebody else's. The original is never written to: the enhanced copy
-- sits beside it as variants.enhanced, and is shown only where this is on.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS enhance boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.event_media_album_settings.enhance IS
  'Show the enhanced copy of each photograph on the portal, where one has been made.';
