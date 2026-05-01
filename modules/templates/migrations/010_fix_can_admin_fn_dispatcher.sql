-- ============================================================================
-- Migration: templates_010_fix_can_admin_fn_dispatcher
-- Description: Fix the can_admin_fn dispatcher in templates.can_read_library
--              and templates.can_read_host so that schema-qualified function
--              names (e.g. 'public.can_admin_event') resolve correctly.
--
-- Bug background:
--   The original 005_templates_rls.sql used:
--     v_sql := format('SELECT %I($1)', v_can_fn);
--   `%I` quotes the entire string as a SINGLE identifier, so
--   'public.can_admin_event' became "public.can_admin_event" — a quoted
--   identifier with a literal dot, which Postgres looks up as a single
--   relation name and fails.
--
--   This bug was latent: events / calendars (PR 17) registered as page
--   hosts but didn't yet create templates_libraries rows, so the dispatcher
--   wasn't exercised. Newsletters (PR 16.b, migration 021) is the first
--   consumer to create libraries with host_kind='newsletter', so the bug
--   surfaces immediately on the first templates_block_defs SELECT.
--
-- Fix:
--   Use `to_regprocedure(v_can_fn || '(uuid)')` which:
--     - Returns NULL if the function doesn't exist or has the wrong sig
--     - Resolves schema-qualified names correctly
--     - Defends against can_admin_fn values that are bare expressions
--   Then `format('SELECT %s($1)', v_oid::regprocedure::text)` produces
--   a properly-cast call.
-- ============================================================================

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
  v_oid        oid;
  v_result     boolean;
  v_sql        text;
BEGIN
  SELECT host_kind, host_id
    INTO v_host_kind, v_host_id
    FROM public.templates_libraries
   WHERE id = p_library_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF to_regclass('public.pages_host_registrations') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE
    'SELECT can_admin_fn FROM public.pages_host_registrations WHERE host_kind = $1 AND enabled = true'
    INTO v_can_fn USING v_host_kind;

  IF v_can_fn IS NULL OR v_can_fn = '' THEN
    RETURN false;
  END IF;

  -- Resolve to a regprocedure. Strips parens, validates schema-qualified
  -- names, returns NULL for missing/wrong-sig functions.
  v_oid := to_regprocedure(rtrim(v_can_fn, '()') || '(uuid)');
  IF v_oid IS NULL THEN
    RETURN false;
  END IF;

  v_sql := format('SELECT %s($1)', v_oid::regprocedure::text);
  EXECUTE v_sql INTO v_result USING v_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

COMMENT ON FUNCTION templates.can_read_library(uuid) IS
  'Dispatches to the host module''s permission helper via pages_host_registrations. Uses to_regprocedure to resolve schema-qualified function names safely. Returns false if sites module not yet installed, the host_kind is not registered, or the can_admin_fn is missing / has wrong signature.';

-- ==========================================================================
-- Same fix for templates.can_read_host
-- ==========================================================================

CREATE OR REPLACE FUNCTION templates.can_read_host(p_host_kind text, p_host_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, templates
AS $$
DECLARE
  v_can_fn  text;
  v_oid     oid;
  v_result  boolean;
  v_sql     text;
BEGIN
  IF to_regclass('public.pages_host_registrations') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE
    'SELECT can_admin_fn FROM public.pages_host_registrations WHERE host_kind = $1 AND enabled = true'
    INTO v_can_fn USING p_host_kind;

  IF v_can_fn IS NULL OR v_can_fn = '' THEN
    RETURN false;
  END IF;

  v_oid := to_regprocedure(rtrim(v_can_fn, '()') || '(uuid)');
  IF v_oid IS NULL THEN
    RETURN false;
  END IF;

  v_sql := format('SELECT %s($1)', v_oid::regprocedure::text);
  EXECUTE v_sql INTO v_result USING p_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;
