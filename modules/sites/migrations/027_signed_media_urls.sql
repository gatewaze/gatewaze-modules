-- ============================================================================
-- Migration: sites_027_signed_media_urls
-- Description: Per-asset access control for media items.
--              Per spec-content-modules-git-architecture §19.5 (deferred to v1.x).
-- ============================================================================

-- access_level on host_media controls how the URL is served.
ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'public'
  CHECK (access_level IN ('public', 'authenticated', 'signed'));

COMMENT ON COLUMN public.host_media.access_level IS
  'Per spec §19.5 (v1.x). public = bucket-public CDN URL; authenticated = SSR session check before serving the URL; signed = time-limited token in the URL (caller mints via /api/admin/<host>/<id>/media/<id>/sign).';

-- ============================================================================
-- Signed-URL audit log (helps debug "why did my hotlink stop working?")
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_signed_url_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id      uuid NOT NULL REFERENCES public.host_media(id) ON DELETE CASCADE,
  minted_by     uuid,
  minted_for    text,                                  -- e.g. 'page:01HXY...' or 'edition:01HXY...'
  ttl_seconds   integer NOT NULL,
  ip_cidr       text,                                  -- optional IP scoping
  expires_at    timestamptz NOT NULL,
  minted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_host_media_signed_url_log_media
  ON public.host_media_signed_url_log (media_id, minted_at DESC);

ALTER TABLE public.host_media_signed_url_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "media_signed_url_log_read_via_host"
  ON public.host_media_signed_url_log FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.host_media m
    WHERE m.id = host_media_signed_url_log.media_id
      AND templates.can_read_host(m.host_kind, m.host_id)
  ));
