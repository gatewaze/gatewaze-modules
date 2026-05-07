-- ============================================================================
-- Migration: host_media_010_chunked_uploads
-- Description: Tracking table for in-flight chunked-upload sessions.
--              chunked-init creates a row; chunked-commit reads it,
--              triggers media-combine-chunks, then deletes the row.
--              Cleanup cron deletes rows where expires_at < now().
-- Per spec-host-media-module §4.2.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_chunked_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind     text NOT NULL,
  host_id       uuid NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  total_bytes   bigint NOT NULL,
  total_chunks  integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','combining','completed','failed','expired')),
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '1 hour')
);

COMMENT ON TABLE public.host_media_chunked_uploads IS
  'In-flight chunked upload session metadata. TTL 1 h; cleanup cron purges expired rows + their orphan storage chunks.';

CREATE INDEX IF NOT EXISTS idx_host_media_chunked_uploads_host
  ON public.host_media_chunked_uploads (host_kind, host_id);

CREATE INDEX IF NOT EXISTS idx_host_media_chunked_uploads_expires
  ON public.host_media_chunked_uploads (expires_at)
  WHERE status IN ('pending','combining');

ALTER TABLE public.host_media_chunked_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS host_media_chunked_uploads_admin_all ON public.host_media_chunked_uploads;
CREATE POLICY host_media_chunked_uploads_admin_all ON public.host_media_chunked_uploads
  USING (public.can_admin_host_media(host_kind, host_id))
  WITH CHECK (public.can_admin_host_media(host_kind, host_id));
