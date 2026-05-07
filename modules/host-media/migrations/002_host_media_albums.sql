-- ============================================================================
-- Migration: host_media_002_albums
-- Description: Albums for media organisation. Generalised from
--              events_media_albums + event_media_album_items (event-media
--              module). Albums are shown in <HostMediaTab> only when the
--              consumer's registry entry has enableAlbums: true.
-- Per spec-host-media-module §4.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_albums (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind       text NOT NULL,
  host_id         uuid NOT NULL,
  name            text NOT NULL,
  description     text,
  cover_media_id  uuid,                          -- FK added in migration 003
  sort_order      integer NOT NULL DEFAULT 0,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.host_media_albums IS
  'Per-host albums for media organisation. Visible only when consumer enables albums in its hostMediaConsumer registry block.';

CREATE INDEX IF NOT EXISTS idx_host_media_albums_host
  ON public.host_media_albums (host_kind, host_id);

CREATE TABLE IF NOT EXISTS public.host_media_album_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id    uuid NOT NULL REFERENCES public.host_media_albums(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL,                     -- FK added in migration 003
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (album_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_host_media_album_items_media
  ON public.host_media_album_items (media_id);
