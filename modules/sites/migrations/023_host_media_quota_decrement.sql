-- ============================================================================
-- Migration: sites_023_host_media_quota_decrement
-- Description: RPC for decrementing host_media_quotas.total_bytes_used
--              on media delete. Used by lib/api/media-routes.ts.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.host_media_quota_decrement(
  p_host_kind text,
  p_host_id uuid,
  p_bytes bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.host_media_quotas
  SET total_bytes_used = GREATEST(0, total_bytes_used - p_bytes)
  WHERE host_kind = p_host_kind AND host_id = p_host_id;
END $$;
