-- ============================================================================
-- Migration: host_media_005_quotas
-- Description: Per-host storage quota table. Lifted from sites' quota
--              table. Pre-flight check + decrement-on-failure pattern
--              used during upload.
-- Per spec-host-media-module §8.6.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_quotas (
  host_kind          text NOT NULL,
  host_id            uuid NOT NULL,
  total_bytes_used   bigint NOT NULL DEFAULT 0,
  total_bytes_cap    bigint NOT NULL DEFAULT 1073741824,    -- 1 GB default
  per_file_cdn_cap   bigint NOT NULL DEFAULT 5242880,       -- 5 MB default for CDN-only files
  per_file_repo_cap  bigint NOT NULL DEFAULT 2097152,       -- 2 MB default for in-repo files
  repo_dir_cap       bigint NOT NULL DEFAULT 209715200,     -- 200 MB default for whole repo dir
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_kind, host_id)
);

COMMENT ON TABLE public.host_media_quotas IS
  'Per-host storage quota. Pre-flight checked on every upload; decremented atomically on failure.';

DROP TRIGGER IF EXISTS host_media_quotas_touch_updated_at ON public.host_media_quotas;
CREATE TRIGGER host_media_quotas_touch_updated_at
  BEFORE UPDATE ON public.host_media_quotas
  FOR EACH ROW EXECUTE FUNCTION public.host_media_touch_updated_at();

-- ============================================================================
-- Pre-flight quota check + advisory-lock-protected reservation.
-- Returns { ok bool, current_bytes bigint, requested_bytes bigint, cap bigint }.
-- Caller is expected to call host_media_quota_decrement on rollback.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.host_media_quota_check(
  p_host_kind text,
  p_host_id uuid,
  p_requested_bytes bigint
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_row public.host_media_quotas%ROWTYPE;
  v_lock_key bigint;
BEGIN
  -- Advisory lock keyed on (host_kind, host_id) — serialises concurrent
  -- uploads against the same host to prevent races on the cap.
  v_lock_key := hashtext(p_host_kind || '|' || p_host_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Fetch or create the quota row with default caps.
  INSERT INTO public.host_media_quotas (host_kind, host_id)
    VALUES (p_host_kind, p_host_id)
    ON CONFLICT (host_kind, host_id) DO NOTHING;

  SELECT * INTO v_row FROM public.host_media_quotas
    WHERE host_kind = p_host_kind AND host_id = p_host_id;

  IF v_row.total_bytes_used + p_requested_bytes > v_row.total_bytes_cap THEN
    RETURN jsonb_build_object(
      'ok', false,
      'current_bytes', v_row.total_bytes_used,
      'requested_bytes', p_requested_bytes,
      'cap', v_row.total_bytes_cap
    );
  END IF;

  -- Reserve the bytes. Caller decrements on failure.
  UPDATE public.host_media_quotas
    SET total_bytes_used = total_bytes_used + p_requested_bytes
    WHERE host_kind = p_host_kind AND host_id = p_host_id;

  RETURN jsonb_build_object(
    'ok', true,
    'current_bytes', v_row.total_bytes_used + p_requested_bytes,
    'requested_bytes', p_requested_bytes,
    'cap', v_row.total_bytes_cap
  );
END $$;

CREATE OR REPLACE FUNCTION public.host_media_quota_decrement(
  p_host_kind text,
  p_host_id uuid,
  p_bytes bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.host_media_quotas
    SET total_bytes_used = GREATEST(0, total_bytes_used - p_bytes)
    WHERE host_kind = p_host_kind AND host_id = p_host_id;
END $$;
