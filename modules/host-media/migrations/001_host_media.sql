-- ============================================================================
-- Migration: host_media_001_host_media
-- Description: Polymorphic media table for sites/events/newsletters/blog/
--              podcasts. host_kind has NO CHECK constraint — RLS dispatch
--              (added in migration 008) is the source of truth; unknown
--              kinds return false from can_admin_host_media() and RLS
--              denies all ops. This avoids per-consumer migration churn
--              when adding new host_kinds.
--
-- Coexistence note: sites' migration 015 already created `host_media`
-- with a subset of columns (no YouTube/access_level/album_id/metadata
-- /caption/alt_text/sponsor_id/is_featured/is_approved/duration
-- /updated_at). This migration is written to coexist:
--   - CREATE TABLE IF NOT EXISTS preserves the existing row data.
--   - ADD COLUMN IF NOT EXISTS extends it with the new columns.
-- Phase 2 of the host-media rollout drops sites' migration 015 entirely
-- (the table moves to host-media's ownership and sites becomes a
-- consumer that doesn't ship its own host_media migrations).
--
-- Per spec-host-media-module §3.4 + §6 + §11.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind     text NOT NULL,
  host_id       uuid NOT NULL,
  storage_path  text NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  bytes         bigint NOT NULL,
  width         integer,
  height        integer,
  variants      jsonb,
  in_repo       boolean NOT NULL DEFAULT false,
  used_in       jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Extend with the columns spec-host-media-module adds on top of
-- sites_015. ADD COLUMN IF NOT EXISTS keeps this idempotent.

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS duration              integer,
  ADD COLUMN IF NOT EXISTS access_level          text NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS youtube_video_id      text,
  ADD COLUMN IF NOT EXISTS youtube_url           text,
  ADD COLUMN IF NOT EXISTS youtube_embed_url     text,
  ADD COLUMN IF NOT EXISTS youtube_thumbnail_url text,
  ADD COLUMN IF NOT EXISTS youtube_upload_status text,
  ADD COLUMN IF NOT EXISTS youtube_uploaded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_processing_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_processing_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_retry_count   integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS youtube_last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS youtube_error_message text,
  ADD COLUMN IF NOT EXISTS album_id              uuid,
  ADD COLUMN IF NOT EXISTS metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS caption               text,
  ADD COLUMN IF NOT EXISTS alt_text              text,
  ADD COLUMN IF NOT EXISTS sponsor_id            uuid,
  ADD COLUMN IF NOT EXISTS is_featured           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_approved           boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at            timestamptz NOT NULL DEFAULT now();

-- access_level CHECK is added separately because IF NOT EXISTS doesn't
-- exist for constraints; we drop-then-add for idempotency.
ALTER TABLE public.host_media DROP CONSTRAINT IF EXISTS host_media_access_level_chk;
ALTER TABLE public.host_media
  ADD CONSTRAINT host_media_access_level_chk
  CHECK (access_level IN ('public','authenticated','signed'));

COMMENT ON TABLE public.host_media IS
  'Polymorphic media table. Source of truth for the per-host Media tab. Owned by @gatewaze-modules/host-media. used_in updated by host_media_sync_refs() PL/pgSQL fn (migration 011) called from per-consumer triggers.';

CREATE INDEX IF NOT EXISTS idx_host_media_host
  ON public.host_media (host_kind, host_id);

CREATE INDEX IF NOT EXISTS idx_host_media_storage_path
  ON public.host_media (storage_path);

CREATE INDEX IF NOT EXISTS idx_host_media_youtube_status
  ON public.host_media (youtube_upload_status)
  WHERE youtube_upload_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_host_media_album
  ON public.host_media (album_id) WHERE album_id IS NOT NULL;

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION public.host_media_touch_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS host_media_touch_updated_at ON public.host_media;
CREATE TRIGGER host_media_touch_updated_at
  BEFORE UPDATE ON public.host_media
  FOR EACH ROW EXECUTE FUNCTION public.host_media_touch_updated_at();
