-- ============================================================================
-- Migration: host_media_004_zip_uploads
-- Description: Tracking table for ZIP unpack jobs. Generalised from
--              events_media_zip_uploads. The media-process-zip edge fn
--              writes here and emits host_media rows + album_items as it
--              walks the archive.
-- Per spec-host-media-module §4.1 (ZIP class) + §13.2 (event-media).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_zip_uploads (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind                text NOT NULL,
  host_id                  uuid NOT NULL,
  file_name                text NOT NULL,
  storage_path             text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processing','completed','failed')),
  total_count              integer DEFAULT 0,
  processed_count          integer DEFAULT 0,
  error_message            text,
  uploaded_by              uuid,
  processing_started_at    timestamptz,
  processing_completed_at  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.host_media_zip_uploads IS
  'ZIP archive unpack job tracker. Polled by <HostMediaTab> for progress display.';

CREATE INDEX IF NOT EXISTS idx_host_media_zip_uploads_host
  ON public.host_media_zip_uploads (host_kind, host_id);

CREATE INDEX IF NOT EXISTS idx_host_media_zip_uploads_status
  ON public.host_media_zip_uploads (status) WHERE status IN ('pending','processing');

DROP TRIGGER IF EXISTS host_media_zip_uploads_touch_updated_at ON public.host_media_zip_uploads;
CREATE TRIGGER host_media_zip_uploads_touch_updated_at
  BEFORE UPDATE ON public.host_media_zip_uploads
  FOR EACH ROW EXECUTE FUNCTION public.host_media_touch_updated_at();
