-- ============================================================================
-- Migration: sites_031_theme_kinds_feature_flag
-- Description: Adds the platform-wide `sites_theme_kinds_enabled` flag that
--              gates the Next.js theme path during the §16.1 staged rollout
--              (per spec-sites-theme-kinds §16 Deployment & Rollback).
--
-- Default: false. Operators flip it to true per environment (staging →
-- canary → prod) once the migration set + supporting infrastructure
-- (publisher credentials, runtime API keys, observability) is verified
-- in place.
--
-- Read sites:
--   - sitesService.createSite/updateSite — refuse theme_kind='nextjs' when off
--   - publish-jobs createPublishJob — refuse jobs for nextjs sites when off
--   - admin/sites/:id/publisher:validate — refuse Git URL probes when off
--
-- Mirrors the pattern from gatewaze/supabase 00024 (`tenancy_v2_enforced`).
-- ============================================================================

INSERT INTO public.platform_settings (key, value)
VALUES ('sites_theme_kinds_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- SQL helper for in-database checks (e.g. RLS policy or trigger that needs
-- to short-circuit when the flag is off). Pattern matches tenancy_v2_enforced().
CREATE OR REPLACE FUNCTION public.sites_theme_kinds_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(
    (SELECT value::boolean FROM public.platform_settings WHERE key = 'sites_theme_kinds_enabled'),
    false
  )
$$;

COMMENT ON FUNCTION public.sites_theme_kinds_enabled() IS
  'Reads the platform_settings sites_theme_kinds_enabled flag (default false). When false, application code must reject theme_kind=''nextjs'' creates / publishes / publisher validation calls with HTTP 400 theme_kinds_disabled.';
