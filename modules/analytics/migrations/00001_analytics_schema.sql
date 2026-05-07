-- ============================================================================
-- Migration: analytics_00001_schema
-- Description: Creates the `analytics` schema (Gatewaze-owned bookkeeping;
--              Umami's own schema lives in a separate `gatewaze_umami` DB
--              bootstrapped by the Helm pre-install Job — see
--              spec-analytics-module §3.3 + §10.1).
--
--              Plus the two RLS helper functions every analyticsService
--              call delegates to: can_read_analytics_property and
--              can_admin_analytics_property. Per spec §5.4.
--
-- Order of file:
--   1. CREATE SCHEMA + GRANTs (so subsequent migrations can put tables here)
--   2. Helper functions (forward-declared as stubs; bodies filled after
--      analytics_properties exists in 00002)
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS analytics;
COMMENT ON SCHEMA analytics IS
  'Gatewaze-owned bookkeeping for the analytics module. Umami''s own data lives in the separate gatewaze_umami database — opaque to Gatewaze.';

GRANT USAGE ON SCHEMA analytics TO authenticated, service_role, anon;
GRANT CREATE ON SCHEMA analytics TO service_role;

-- Helper: can the current user READ analytics for this property?
-- Stub implementation — body filled in 00002 once analytics_properties
-- exists. Returns true unconditionally for service_role; everything else
-- falls through to the dispatch in 00002.
CREATE OR REPLACE FUNCTION public.can_read_analytics_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT current_setting('role', true) IN ('service_role', 'postgres')
$$;

COMMENT ON FUNCTION public.can_read_analytics_property(uuid) IS
  'True iff the current authenticated user can read analytics dashboards for the given property. Body filled in 00002 after analytics_properties exists. Used by every analyticsService method.';

-- Helper: stricter — can they EDIT it (settings, scripts, segment key)?
CREATE OR REPLACE FUNCTION public.can_admin_analytics_property(p_property_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT current_setting('role', true) IN ('service_role', 'postgres')
$$;

COMMENT ON FUNCTION public.can_admin_analytics_property(uuid) IS
  'True iff the current authenticated user can edit settings (scripts, segment key, domains) for the given property. Stricter than can_read. Body filled in 00002.';
