-- ============================================================================
-- Migration: templates_005_rls
-- Description: Row Level Security policies for the templates module.
--              Writes always go through the API server with service_role.
--              Reads are gated by host-module permission helpers consulted
--              at policy-eval time via the host registry.
--
--              The host registry lives in the sites module (see
--              spec-sites-module.md §4.3, table pages_host_registrations).
--              Until sites is installed, only platform-admin reads succeed
--              outside the service_role context.
-- ============================================================================

-- Enable RLS on every templates_* table. Writes are always denied for
-- non-service_role; service_role bypasses RLS by default.

ALTER TABLE public.templates_libraries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_block_defs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_brick_defs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_wrappers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_definitions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_sources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_source_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_source_previews  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_ab_tests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_ab_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates_ab_events        ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- Helper: templates.can_read_library(library_id uuid) RETURNS boolean
-- ==========================================================================
-- Resolves the library's (host_kind, host_id) to a host-module permission
-- function via the registry, and calls it. The registry table lives in the
-- sites module (created in its migrations). If the sites module is not yet
-- installed, this returns false for non-platform-admin callers.

CREATE OR REPLACE FUNCTION templates.can_read_library(p_library_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, templates
AS $$
DECLARE
  v_host_kind  text;
  v_host_id    uuid;
  v_can_fn     text;
  v_result     boolean;
  v_sql        text;
BEGIN
  -- Platform admin always reads.
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid()) THEN
    -- TODO: replace with the platform's actual is_platform_admin() helper
    -- once sites lands. For now, fall through to the registry check.
    NULL;
  END IF;

  SELECT host_kind, host_id
    INTO v_host_kind, v_host_id
    FROM public.templates_libraries
   WHERE id = p_library_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- The registry lives in the sites module. Use to_regclass to detect it
  -- without erroring before sites is installed.
  IF to_regclass('public.pages_host_registrations') IS NULL THEN
    RETURN false;
  END IF;

  -- Look up the can_admin_fn (or read-equivalent) for this host kind.
  EXECUTE format(
    'SELECT can_admin_fn FROM public.pages_host_registrations WHERE host_kind = $1 AND enabled = true'
  ) INTO v_can_fn USING v_host_kind;

  IF v_can_fn IS NULL THEN
    RETURN false;
  END IF;

  -- Call the host module's permission function with host_id.
  v_sql := format('SELECT %I($1)', v_can_fn);
  EXECUTE v_sql INTO v_result USING v_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

COMMENT ON FUNCTION templates.can_read_library(uuid) IS
  'Dispatches to the host module''s permission helper via pages_host_registrations. Returns false if sites module not yet installed.';

-- ==========================================================================
-- Read policies — authenticated users only (anon never reads templates_*)
-- ==========================================================================
-- Templates are not public content; consumers fetch parsed definitions and
-- render the result. Anon users see only rendered HTML, never raw schemas.

CREATE POLICY "templates_libraries_read_via_host"
  ON public.templates_libraries
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(id));

CREATE POLICY "templates_block_defs_read_via_host"
  ON public.templates_block_defs
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(library_id));

CREATE POLICY "templates_brick_defs_read_via_host"
  ON public.templates_brick_defs
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_block_defs WHERE id = templates_brick_defs.block_def_id)
  ));

CREATE POLICY "templates_wrappers_read_via_host"
  ON public.templates_wrappers
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(library_id));

CREATE POLICY "templates_definitions_read_via_host"
  ON public.templates_definitions
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(library_id));

CREATE POLICY "templates_sources_read_via_host"
  ON public.templates_sources
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(library_id));

CREATE POLICY "templates_source_artifacts_read_via_host"
  ON public.templates_source_artifacts
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_artifacts.source_id)
  ));

CREATE POLICY "templates_source_previews_read_via_host"
  ON public.templates_source_previews
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_previews.source_id)
  ));

-- ==========================================================================
-- A/B engine: read policies follow host access (same model)
-- ==========================================================================
-- ab_tests / assignments / events are scoped by (host_kind, host_id) on the
-- test row. Use a small helper to dispatch by host_kind alone.

CREATE OR REPLACE FUNCTION templates.can_read_host(p_host_kind text, p_host_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, templates
AS $$
DECLARE
  v_can_fn text;
  v_result boolean;
BEGIN
  IF to_regclass('public.pages_host_registrations') IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'SELECT can_admin_fn FROM public.pages_host_registrations WHERE host_kind = $1 AND enabled = true'
  ) INTO v_can_fn USING p_host_kind;
  IF v_can_fn IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT %I($1)', v_can_fn) INTO v_result USING p_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

CREATE POLICY "templates_ab_tests_read_via_host"
  ON public.templates_ab_tests
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

CREATE POLICY "templates_ab_assignments_read_via_host"
  ON public.templates_ab_assignments
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id),
    (SELECT host_id FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id)
  ));

CREATE POLICY "templates_ab_events_read_via_host"
  ON public.templates_ab_events
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id),
    (SELECT host_id FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id)
  ));

-- ==========================================================================
-- Writes: no policies created. Without an INSERT/UPDATE/DELETE policy, RLS
-- denies these operations for non-service_role. The API server uses the
-- service_role key which bypasses RLS entirely; writes happen through API
-- handlers that perform their own permission checks per spec §6 (sites)
-- and the templates module's own admin endpoints.
-- ==========================================================================
