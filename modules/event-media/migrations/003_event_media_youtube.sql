-- ============================================================================
-- Module: event-media
-- Migration: 003_event_media_youtube
-- Description: Add YouTube integration columns, approval flag, upload-method
--              metadata, thumbnail path, and uploader_id to events_media so
--              data from a legacy system can be carried across losslessly.
--
-- These columns existed on a legacy public.event_media table
-- and must be preserved during the data migration.
-- ============================================================================

ALTER TABLE public.events_media
  ADD COLUMN IF NOT EXISTS is_approved                      boolean       DEFAULT true,
  ADD COLUMN IF NOT EXISTS metadata                         jsonb         DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS thumbnail_path                   text,
  ADD COLUMN IF NOT EXISTS upload_method                    text,
  ADD COLUMN IF NOT EXISTS upload_source                    text,
  ADD COLUMN IF NOT EXISTS uploader_id                      uuid,
  ADD COLUMN IF NOT EXISTS duration                         integer,
  -- YouTube integration state carried from legacy event_media
  ADD COLUMN IF NOT EXISTS youtube_channel_id               text,
  ADD COLUMN IF NOT EXISTS youtube_video_id                 text,
  ADD COLUMN IF NOT EXISTS youtube_url                      text,
  ADD COLUMN IF NOT EXISTS youtube_embed_url                text,
  ADD COLUMN IF NOT EXISTS youtube_thumbnail_url            text,
  ADD COLUMN IF NOT EXISTS youtube_upload_status            text,
  ADD COLUMN IF NOT EXISTS youtube_uploaded_at              timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_processing_started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_processing_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_retry_count              integer       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS youtube_last_retry_at            timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_next_retry_at            timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_error_message            text;

CREATE INDEX IF NOT EXISTS idx_events_media_youtube_video_id
  ON public.events_media (youtube_video_id)
  WHERE youtube_video_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_media_youtube_upload_status
  ON public.events_media (youtube_upload_status)
  WHERE youtube_upload_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_media_is_approved
  ON public.events_media (is_approved);
