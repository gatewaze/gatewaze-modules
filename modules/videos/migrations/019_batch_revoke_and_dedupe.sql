-- ============================================================================
-- Module: videos
-- Migration: 019_batch_revoke_and_dedupe
-- Description: remember whether a batch key was actually revoked, and make
--              one uploaded object adopt once.
--
-- Closing a batch deletes its key at Backblaze, but that call can fail and
-- the batch used to be marked closed regardless, leaving a write-capable key
-- live until it expired. key_revoked_at records the fact; the sync cron
-- retries the revoke for any closed or expired batch without it.
--
-- The unique index stops two overlapping syncs adopting the same object
-- twice, and stops a failed adoption being retried into a second video row.
-- ============================================================================

ALTER TABLE public.video_upload_batches
  ADD COLUMN IF NOT EXISTS key_revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS video_upload_batches_unrevoked
  ON public.video_upload_batches (id) WHERE key_id IS NOT NULL AND key_revoked_at IS NULL AND state <> 'open';

CREATE UNIQUE INDEX IF NOT EXISTS video_assets_batch_import_once
  ON public.video_assets (batch_id, import_path) WHERE batch_id IS NOT NULL AND import_path IS NOT NULL;
