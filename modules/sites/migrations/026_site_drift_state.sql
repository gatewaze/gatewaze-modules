-- ============================================================================
-- Migration: sites_026_site_drift_state
-- Description: Cached drift state populated by the drift-watcher cron.
--              Source tab reads from this for the "X commits ahead"
--              indicator without re-running git commands per page load.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.site_drift_state (
  site_id        uuid PRIMARY KEY REFERENCES public.sites(id) ON DELETE CASCADE,
  main_sha       text NOT NULL,
  publish_sha    text,
  commits_ahead  integer NOT NULL DEFAULT 0,
  has_conflicts  boolean NOT NULL DEFAULT false,
  block_schema_changes integer NOT NULL DEFAULT 0,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  fetch_error    text
);

COMMENT ON TABLE public.site_drift_state IS
  'Per spec §22.1 + drift-watcher cron: cached drift state. checked_at is the last successful drift check; fetch_error logs the most recent fetch failure (e.g. deploy key revoked).';

CREATE INDEX IF NOT EXISTS idx_site_drift_state_checked_at
  ON public.site_drift_state (checked_at DESC);

-- ============================================================================
-- RLS — admin can read; service-role writes
-- ============================================================================

ALTER TABLE public.site_drift_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_drift_state_read_via_site"
  ON public.site_drift_state FOR SELECT TO authenticated
  USING (public.can_admin_site(site_id));
