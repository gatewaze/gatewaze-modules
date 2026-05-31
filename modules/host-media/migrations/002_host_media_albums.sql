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
  cover_media_id  uuid,                          -- circular FK added at end of this migration
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
  media_id    uuid NOT NULL,                     -- circular FK added at end of this migration
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (album_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_host_media_album_items_media
  ON public.host_media_album_items (media_id);

-- ----------------------------------------------------------------------------
-- Circular FKs between host_media and the album tables (folded from former
-- migration 003_album_circular_fks). Added here, after both host_media
-- (migration 001) and the album tables above exist, because the references
-- form a cycle that cannot be expressed inline in the CREATE statements.
--   host_media.album_id            -> host_media_albums (ON DELETE SET NULL)
--   host_media_albums.cover_media_id -> host_media       (ON DELETE SET NULL)
--   host_media_album_items.media_id  -> host_media       (ON DELETE CASCADE)
-- Per spec-host-media-module §6.
-- ----------------------------------------------------------------------------
ALTER TABLE public.host_media
  DROP CONSTRAINT IF EXISTS host_media_album_id_fkey;
ALTER TABLE public.host_media
  ADD CONSTRAINT host_media_album_id_fkey
  FOREIGN KEY (album_id) REFERENCES public.host_media_albums(id) ON DELETE SET NULL;

ALTER TABLE public.host_media_albums
  DROP CONSTRAINT IF EXISTS host_media_albums_cover_media_id_fkey;
ALTER TABLE public.host_media_albums
  ADD CONSTRAINT host_media_albums_cover_media_id_fkey
  FOREIGN KEY (cover_media_id) REFERENCES public.host_media(id) ON DELETE SET NULL;

ALTER TABLE public.host_media_album_items
  DROP CONSTRAINT IF EXISTS host_media_album_items_media_id_fkey;
ALTER TABLE public.host_media_album_items
  ADD CONSTRAINT host_media_album_items_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES public.host_media(id) ON DELETE CASCADE;
