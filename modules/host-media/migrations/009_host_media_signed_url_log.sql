-- ============================================================================
-- Migration: host_media_009_signed_url_log
-- Description: Audit table for signed-URL issuance. Sites' migration 027
--              already created this table with column names
--              (minted_by, minted_for, ttl_seconds, ip_cidr, expires_at,
--               minted_at). We coexist by ensuring those columns exist
--              and adding the user_agent column we additionally use.
--              Phase 2 unifies ownership under host-media.
-- Per spec-host-media-module §8.12.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_signed_url_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id     uuid NOT NULL REFERENCES public.host_media(id) ON DELETE CASCADE,
  minted_by    uuid,
  minted_for   text,
  ttl_seconds  integer NOT NULL DEFAULT 3600,
  ip_cidr      text,
  expires_at   timestamptz NOT NULL,
  minted_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.host_media_signed_url_log
  ADD COLUMN IF NOT EXISTS user_agent text;

COMMENT ON TABLE public.host_media_signed_url_log IS
  'Audit log of every signed URL handed out for access_level=signed media. Used for abuse detection + compliance.';

CREATE INDEX IF NOT EXISTS idx_host_media_signed_url_log_media
  ON public.host_media_signed_url_log (media_id, minted_at DESC);

CREATE INDEX IF NOT EXISTS idx_host_media_signed_url_log_user
  ON public.host_media_signed_url_log (minted_by, minted_at DESC);

ALTER TABLE public.host_media_signed_url_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS host_media_signed_url_log_self_read ON public.host_media_signed_url_log;
CREATE POLICY host_media_signed_url_log_self_read ON public.host_media_signed_url_log
  FOR SELECT USING (minted_by = auth.uid());
