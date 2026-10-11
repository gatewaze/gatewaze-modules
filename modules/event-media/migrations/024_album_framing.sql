-- The shape an album's improved copies are delivered in.
--
-- Measured on 2026-09-29: 79 of 80 photographs in the wedding
-- photographer's published portfolio are 3:2 or 2:3, the shape a camera
-- gives you. The guests' own are 3:4 and 4:3, the shape a phone gives
-- you. It is a real part of why one set reads as professional, and
-- unlike the rest of his framing it costs nothing to match.
--
--   as-shot   leave the frame as the phone gave it
--   classic   crop to 3:2 or 3:2 portrait -- about a ninth of the width,
--             nothing invented
--   expand    add the difference instead of taking it away, with a model
--             drawing only what lies OUTSIDE the photograph. Costs money
--             per photograph, and only applies to a relight pass; an
--             album set to expand that is only being enhanced the
--             ordinary way is cropped instead.
--
-- What none of these do is change how much of the frame the subject
-- fills. His faces occupy 13% of frame height and the guests' 27%: he
-- stood further back. A crop can only make a subject larger, and closing
-- that by generation would mean inventing most of the picture.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS frame text NOT NULL DEFAULT 'as-shot';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_media_album_settings_frame_check'
  ) THEN
    ALTER TABLE public.event_media_album_settings
      ADD CONSTRAINT event_media_album_settings_frame_check
      CHECK (frame IN ('as-shot', 'classic', 'expand'));
  END IF;
END $$;

COMMENT ON COLUMN public.event_media_album_settings.frame IS
  'Shape of this album''s improved copies: as-shot, classic (crop to 3:2/2:3), or expand (outpaint to it).';
