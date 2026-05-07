-- ============================================================================
-- Migration: host_media_007_youtube_columns
-- Description: All YouTube columns are already in host_media (migration 001).
--              This migration is a placeholder kept in the sequence for
--              symmetry with the spec's migration list and to add any
--              YouTube-specific indexes that depend on the columns being
--              populated by event-data load.
-- Per spec-host-media-module §3.1 + §13.2 (event-media YouTube).
-- ============================================================================

-- Index for the youtube-poll worker to find pending uploads efficiently.
CREATE INDEX IF NOT EXISTS idx_host_media_youtube_poll
  ON public.host_media (youtube_next_retry_at)
  WHERE youtube_upload_status IN ('pending','failed')
    AND youtube_next_retry_at IS NOT NULL;
