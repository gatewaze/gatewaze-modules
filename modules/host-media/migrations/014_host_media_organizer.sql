-- ============================================================================
-- Migration: host_media_014_organizer
-- Description: Backing for the media organizer (custom ordering).
--
--   1. host_media.display_order — the host-wide "Custom order" position.
--      NULL means "never placed"; those rows sort after placed rows,
--      newest first (the legacy event_media.display_order semantics,
--      where 0/NULL fell to the end).
--   2. host_media_set_display_order(kind, id, ids[]) — rewrites the
--      custom order for a host in ONE statement from an ordered id list.
--      Ids that do not belong to the host are ignored by the WHERE.
--   3. host_media_set_album_order(album, ids[]) — same for an album's
--      items (host_media_album_items.sort_order).
--
-- Both functions are SECURITY INVOKER and are only granted to
-- service_role: the host-media API authorizes the caller
-- (can_admin_host_media) before invoking them.
-- ============================================================================

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS display_order integer;

CREATE INDEX IF NOT EXISTS idx_host_media_display_order
  ON public.host_media (host_kind, host_id, display_order)
  WHERE display_order IS NOT NULL;

CREATE OR REPLACE FUNCTION public.host_media_set_display_order(
  p_host_kind text,
  p_host_id   uuid,
  p_ids       uuid[]
) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  WITH ordered AS (
    SELECT id, ord::integer AS pos
      FROM unnest(p_ids) WITH ORDINALITY AS t(id, ord)
  ), updated AS (
    UPDATE public.host_media m
       SET display_order = o.pos * 10
      FROM ordered o
     WHERE m.id = o.id
       AND m.host_kind = p_host_kind
       AND m.host_id = p_host_id
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$$;

CREATE OR REPLACE FUNCTION public.host_media_set_album_order(
  p_album_id uuid,
  p_ids      uuid[]
) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  WITH ordered AS (
    SELECT id, ord::integer AS pos
      FROM unnest(p_ids) WITH ORDINALITY AS t(id, ord)
  ), updated AS (
    UPDATE public.host_media_album_items i
       SET sort_order = o.pos * 10
      FROM ordered o
     WHERE i.media_id = o.id
       AND i.album_id = p_album_id
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$$;

REVOKE ALL ON FUNCTION public.host_media_set_display_order(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.host_media_set_album_order(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.host_media_set_display_order(text, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.host_media_set_album_order(uuid, uuid[]) TO service_role;
