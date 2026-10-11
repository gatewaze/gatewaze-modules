-- 029: the blocks a new edition starts with.
--
-- A template repo can ship an `edition.json` next to its blocks/ directory
-- listing the blocks (in order, optionally with starting content) every new
-- edition is seeded with. The git ingest reads it on connect and on every
-- Update and stores it here; the consumer's "New edition" flow reads it and
-- resolves each key against the library's current block defs.
--
-- Shape: { "version": 1, "blocks": [ { "key": "...", "content"?: {...} } ] }
-- NULL = the repo declares nothing (new editions start empty).
--
-- Trust: the ingest validates the file (service role), but migration 011's
-- table-wide UPDATE grant means any admin of the host can also write this
-- column directly through PostgREST. The CHECK below pins the outer shape
-- and size at the database so a hand-written value cannot be a multi-MB
-- blob or a non-list, and the consumer re-validates every entry on read.
-- No grant changes: authenticated already reads templates_libraries through
-- the host-scoped RLS policy.

ALTER TABLE public.templates_libraries
  ADD COLUMN IF NOT EXISTS new_edition_blocks jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'templates_libraries_new_edition_blocks_shape'
      AND conrelid = 'public.templates_libraries'::regclass
  ) THEN
    ALTER TABLE public.templates_libraries
      ADD CONSTRAINT templates_libraries_new_edition_blocks_shape CHECK (
        new_edition_blocks IS NULL OR (
          jsonb_typeof(new_edition_blocks) = 'object'
          AND jsonb_typeof(new_edition_blocks -> 'blocks') = 'array'
          AND jsonb_array_length(new_edition_blocks -> 'blocks') <= 50
          AND pg_column_size(new_edition_blocks) <= 65536
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.templates_libraries.new_edition_blocks IS
  'Blocks a new edition starts with, from the template repo''s edition.json: {version:1, blocks:[{key, content?}]}. NULL when the repo declares nothing. Shape/size pinned by CHECK; consumers re-validate entries.';
