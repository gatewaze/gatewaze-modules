-- ============================================================================
-- Migration: host_media_008_rls_dispatch
-- Description: Single dispatch function can_admin_host_media() +
--              can_read_host_media() that branches on host_kind. Each
--              consumer module's migration extends these via CREATE OR
--              REPLACE to add its branch. Unknown kind → deny.
--              SECURITY INVOKER (default) — every caller is JWT-
--              authenticated upstream by requireJwt().
--
-- Convention: per-kind ADMIN dispatch calls existing
--              `public.can_admin_<kind>(uuid)` fns shipped by each
--              consumer module (sites_005, newsletters_020a,
--              events_002 etc.). READ dispatch leans on
--              `templates.can_read_host(text, uuid)` which itself
--              dispatches via pages_host_registrations.
--
-- Per spec-host-media-module §3.3 + §8.1.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_admin_host_media(
  p_host_kind text,
  p_host_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  -- Branches added/replaced by consumer-module migrations as new
  -- host_kinds opt in. Default-deny for unknown kinds.
  CASE p_host_kind
    WHEN 'site' THEN
      RETURN public.can_admin_site(p_host_id);
    WHEN 'newsletter' THEN
      RETURN public.can_admin_newsletter(p_host_id);
    WHEN 'event' THEN
      RETURN public.can_admin_event(p_host_id);
    ELSE
      RETURN false;
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION public.can_read_host_media(
  p_host_kind text,
  p_host_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  -- For reads we delegate to templates.can_read_host which itself
  -- dispatches via pages_host_registrations — same pattern templates
  -- ships for pages/page_blocks RLS.
  RETURN templates.can_read_host(p_host_kind, p_host_id);
END $$;

-- ============================================================================
-- RLS policies. host_media + albums + album_items + zip_uploads + quotas
-- all dispatch through can_admin_host_media() for writes and
-- can_read_host_media() for reads.
-- ============================================================================

ALTER TABLE public.host_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_media_albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_media_album_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_media_zip_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_media_quotas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS host_media_admin_all ON public.host_media;
CREATE POLICY host_media_admin_all ON public.host_media
  USING (public.can_admin_host_media(host_kind, host_id))
  WITH CHECK (public.can_admin_host_media(host_kind, host_id));

DROP POLICY IF EXISTS host_media_public_read ON public.host_media;
CREATE POLICY host_media_public_read ON public.host_media FOR SELECT
  USING (
    access_level = 'public'
    AND public.can_read_host_media(host_kind, host_id)
  );

DROP POLICY IF EXISTS host_media_albums_admin_all ON public.host_media_albums;
CREATE POLICY host_media_albums_admin_all ON public.host_media_albums
  USING (public.can_admin_host_media(host_kind, host_id))
  WITH CHECK (public.can_admin_host_media(host_kind, host_id));

DROP POLICY IF EXISTS host_media_album_items_admin_all ON public.host_media_album_items;
CREATE POLICY host_media_album_items_admin_all ON public.host_media_album_items
  USING (
    EXISTS (
      SELECT 1 FROM public.host_media_albums a
        WHERE a.id = host_media_album_items.album_id
          AND public.can_admin_host_media(a.host_kind, a.host_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.host_media_albums a
        WHERE a.id = host_media_album_items.album_id
          AND public.can_admin_host_media(a.host_kind, a.host_id)
    )
  );

DROP POLICY IF EXISTS host_media_zip_uploads_admin_all ON public.host_media_zip_uploads;
CREATE POLICY host_media_zip_uploads_admin_all ON public.host_media_zip_uploads
  USING (public.can_admin_host_media(host_kind, host_id))
  WITH CHECK (public.can_admin_host_media(host_kind, host_id));

DROP POLICY IF EXISTS host_media_quotas_admin_all ON public.host_media_quotas;
CREATE POLICY host_media_quotas_admin_all ON public.host_media_quotas
  USING (public.can_admin_host_media(host_kind, host_id))
  WITH CHECK (public.can_admin_host_media(host_kind, host_id));
