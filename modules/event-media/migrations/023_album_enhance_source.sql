-- Which improved copy an album shows.
--
-- There are now two ways to improve a photograph and they are different
-- in kind, not in degree. The standard one is arithmetic on the pixels
-- that are already there: free, run in the organiser's browser, and
-- incapable of inventing anything. The other reconstructs the photograph
-- through a diffusion model -- it costs money per photograph, and it
-- invents. Run over the night-before album on 2026-09-29 it switched on
-- a picture light above a painting that nobody had lit.
--
-- So an organiser chooses, per album, rather than getting whichever was
-- made last. `enhance` stays as it was -- whether to show an improved
-- copy at all -- and this says which one to show when there is a choice.
-- An album set to 'ai' with no relit copy falls back to the standard
-- one, so turning this on before the album has been run shows what is
-- there rather than nothing.
--
-- Both copies are kept either way. Switching back does not throw away
-- what was paid for, and it makes comparing the two free.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS enhance_source text NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_media_album_settings_enhance_source_check'
  ) THEN
    ALTER TABLE public.event_media_album_settings
      ADD CONSTRAINT event_media_album_settings_enhance_source_check
      CHECK (enhance_source IN ('standard', 'ai'));
  END IF;
END $$;

COMMENT ON COLUMN public.event_media_album_settings.enhance_source IS
  'Which improved copy this album shows where enhance is on: the arithmetic one (standard) or the model''s (ai).';
