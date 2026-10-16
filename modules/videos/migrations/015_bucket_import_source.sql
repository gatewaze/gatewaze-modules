-- ============================================================================
-- Module: videos
-- Migration: 015_bucket_import_source
-- Description: a master can be adopted from an object that was put in the
--              bucket by something other than this module (a local shipper
--              after a yt-dlp run, a bulk copy). Its provenance is recorded
--              as its own source so it is never mistaken for an editor's
--              upload or a Drive import.
-- ============================================================================

ALTER TABLE public.video_assets DROP CONSTRAINT IF EXISTS video_assets_source_check;
ALTER TABLE public.video_assets
  ADD CONSTRAINT video_assets_source_check
  CHECK (source IN ('upload', 'youtube_import', 'recap', 'drive_import', 'bucket_import'));
