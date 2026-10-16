-- ============================================================================
-- Module: videos
-- Migration: 018_batch_import_path
-- Description: where a batch-adopted master came from.
--
-- A batch key can hide what it uploaded (Backblaze treats an S3 delete as a
-- hide, and `writeFiles` allows it), so an adopted master is a server-side
-- COPY of the uploaded object, at a path the key cannot reach. The original
-- path is kept so the sync can tell "already adopted" from "new file" and
-- notice a replaced upload.
-- ============================================================================

ALTER TABLE public.video_assets
  ADD COLUMN IF NOT EXISTS import_path text;

COMMENT ON COLUMN public.video_assets.import_path IS
  'For a batch-adopted master: the object it was copied from, under the batch prefix.';

CREATE INDEX IF NOT EXISTS video_assets_import_path
  ON public.video_assets (batch_id, import_path) WHERE import_path IS NOT NULL;
