-- ============================================================================
-- Migration: sites_014_internal_repos
-- Description: Registry of internal git repos (bare repos on PVC).
--              Per spec-content-modules-git-architecture §6.3 + §18.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.gatewaze_internal_repos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind       text NOT NULL,        -- 'site' | 'list' | 'newsletter' | future
  host_id         uuid NOT NULL,
  bare_path       text NOT NULL,        -- /var/gatewaze/git/<host_kind>/<slug>.git
  default_branch  text NOT NULL DEFAULT 'main',
  size_bytes      bigint NOT NULL DEFAULT 0,
  last_pushed_at  timestamptz,
  -- Soft-delete for 30-day grace period (per spec §6.3)
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_kind, host_id)
);

COMMENT ON TABLE public.gatewaze_internal_repos IS
  'Registry of bare git repos on PVC, owned by gatewaze for sites/lists without external git. deleted_at supports 30-day restore grace period.';

CREATE INDEX IF NOT EXISTS idx_gatewaze_internal_repos_host
  ON public.gatewaze_internal_repos (host_kind, host_id);

CREATE INDEX IF NOT EXISTS idx_gatewaze_internal_repos_deleted
  ON public.gatewaze_internal_repos (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- Per-repo size cap config (per spec §6.3) — exposed via platform_settings,
-- but we store the resolved cap here for fast lookup. Default 500 MB.
-- ============================================================================

ALTER TABLE public.gatewaze_internal_repos
  ADD COLUMN IF NOT EXISTS max_size_bytes bigint NOT NULL DEFAULT 524288000;
-- 500 MB = 500 * 1024 * 1024 = 524288000

COMMENT ON COLUMN public.gatewaze_internal_repos.max_size_bytes IS
  'Per-repo size cap. Push exceeding this rejected with 413. Configurable via config.git.internal_repo_max_bytes; this column stores the resolved value at repo-create time.';

-- ============================================================================
-- RLS — only platform admins (or service-role) read/write the registry.
-- The git endpoint itself authorizes per-repo access via JWT or signed URL.
-- ============================================================================

ALTER TABLE public.gatewaze_internal_repos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "internal_repos_admin_only"
  ON public.gatewaze_internal_repos
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
