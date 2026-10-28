-- An album the portal can play as a slideshow.
--
-- A photographer's full delivery is thousands of frames shot in bursts
-- through the day, close enough together that played in the order they
-- were taken they read almost as film (asked 2026-10-28). The organiser
-- turns this on per album; the gallery then offers a Play button on it,
-- and the viewer chooses the speed.
--
-- Off by default, so no album changes until someone asks for it.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS slideshow boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.event_media_album_settings.slideshow IS
  'The portal offers this album as a slideshow, played in the order the photographs were taken.';
