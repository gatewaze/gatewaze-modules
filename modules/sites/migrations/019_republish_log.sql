-- ============================================================================
-- Migration: sites_019_republish_log
-- Description: Republish trigger audit log + dedup index.
--              Per spec-content-modules-git-architecture §6.7 + §18.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.site_republish_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  trigger_kind        text NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled', 'webhook', 'mcp')),
  triggered_by        uuid,                              -- admin user id (manual/MCP) or NULL (scheduled/webhook)
  webhook_request_id  text,                              -- for webhook dedup (24h window)
  reason              text,                              -- commit message context
  publish_commit_sha  text,
  publish_tag         text,
  status              text NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'skipped_no_diff')),
  error_message       text,                              -- populated when status='failed'
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

COMMENT ON TABLE public.site_republish_log IS
  'Per spec §6.7: audit log of all republish triggers (manual / scheduled / webhook / MCP). Used by Publishing tab in-flight panel and for webhook replay protection.';

CREATE INDEX IF NOT EXISTS idx_site_republish_log_site_started
  ON public.site_republish_log (site_id, started_at DESC);

-- 24h replay protection on webhook dedup id
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_republish_log_webhook_dedup
  ON public.site_republish_log (site_id, webhook_request_id)
  WHERE webhook_request_id IS NOT NULL;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.site_republish_log ENABLE ROW LEVEL SECURITY;

-- Admin (per-site) can read; service-role bypasses for the actual writes
CREATE POLICY "republish_log_read_via_site"
  ON public.site_republish_log FOR SELECT TO authenticated
  USING (public.can_admin_site(site_id));
