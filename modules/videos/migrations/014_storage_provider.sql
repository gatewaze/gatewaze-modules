-- ============================================================================
-- Module: videos
-- Migration: 014_storage_provider
-- Description: masters may live in an S3-compatible store, not only Supabase.
--
-- Supabase Storage charges $0.09/GB to read, and every thumbnail pass reads
-- each master once. Backblaze B2 reads are free up to 3x the stored amount a
-- month and storage is a third of the price, so the masters move there. The
-- bucket name alone no longer says where a file is, because 'video-masters'
-- on Supabase and 'aaif-video-masters' on B2 are different APIs; a provider
-- column says which one to call.
--
-- Additive. Every existing row is Supabase, which is what the default says.
-- ============================================================================

ALTER TABLE public.video_assets
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase'
    CHECK (storage_provider IN ('supabase', 's3'));

ALTER TABLE public.video_upload_sessions
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase'
    CHECK (storage_provider IN ('supabase', 's3'));

COMMENT ON COLUMN public.video_assets.storage_provider IS
  'Which storage API holds the object: supabase (Supabase Storage) or s3 (an S3-compatible bucket, VIDEO_S3_* in the environment). Decides how storage_bucket/storage_path are read.';

-- A Takeout or YouTube import that could not be matched to a known video, or
-- a file that arrived through a store the module did not sign for.
ALTER TABLE public.video_assets DROP CONSTRAINT IF EXISTS video_assets_source_check;
ALTER TABLE public.video_assets
  ADD CONSTRAINT video_assets_source_check
  CHECK (source IN ('upload', 'youtube_import', 'recap', 'drive_import'));
