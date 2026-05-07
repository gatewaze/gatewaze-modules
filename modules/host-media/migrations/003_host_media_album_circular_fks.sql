-- ============================================================================
-- Migration: host_media_003_album_circular_fks
-- Description: Adds the circular FKs between host_media and
--              host_media_albums after both tables exist. host_media
--              references albums via album_id (ON DELETE SET NULL —
--              album disappears, media survives) and host_media_albums
--              references media via cover_media_id (ON DELETE SET NULL —
--              cover image deleted, album survives).
-- Per spec-host-media-module §6.
-- ============================================================================

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
