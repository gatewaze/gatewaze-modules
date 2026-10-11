-- X-ray, per album.
--
-- The booth keeps the selfie a guest actually took as well as the picture
-- it made of them, and the portal can show those instead -- half the fun
-- is seeing what it started with. But a selfie is not what anybody posed
-- for, so whether guests can see them is the organiser's decision and not
-- a default (asked 2026-09-28).
--
-- Off unless it is turned on. An album with no setting row shows the
-- booth's pictures and nothing behind them.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS xray boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.event_media_album_settings.xray IS
  'Let the portal show the selfies behind this album''s booth pictures.';
