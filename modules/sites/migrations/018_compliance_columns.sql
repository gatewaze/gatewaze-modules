-- ============================================================================
-- Migration: sites_018_compliance_columns
-- Description: Per-site compliance integration toggles.
--              Per spec-content-modules-git-architecture §13.
-- ============================================================================

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS compliance_audit_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sites.compliance_audit_enabled IS
  'Per spec §13.4: when compliance module installed, this enables emission of site events (page_view, form_submit, conversion, login, logout) to compliance_audit_log. Off by default to keep audit-log volume bounded.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS compliance_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.sites.compliance_overrides IS
  'Per-site overrides keyed by feature: { cookie_banner_enabled: bool, privacy_routes_enabled: bool, audit_enabled: bool }. Read by the compliance integration when rendering the site shell. Defaults from §13.1 apply when key absent.';
