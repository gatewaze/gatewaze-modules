-- ============================================================================
-- Migration: templates_012_fix_select_policies_and_grants
-- Description: Three permanent fixes captured during the AAIF dogfood pass
--              of "+ Provision starter templates" (sites admin UI):
--
--   1. regprocedure::text -> regproc::text in the dispatcher.
--      010 used `v_oid::regprocedure::text` which renders as
--      `public.can_admin_site(uuid)` — INCLUDES the arg list. The dispatcher
--      then formats `SELECT %s($1)` producing
--      `SELECT public.can_admin_site(uuid)($1)` — malformed.
--      `regproc::text` renders the function NAME only
--      (`public.can_admin_site`), so the formatted call is well-formed.
--
--   2. GRANT USAGE ON SCHEMA templates + GRANT EXECUTE on both dispatcher
--      functions to authenticated/anon. Without USAGE on the templates
--      schema, RLS policies that reference `templates.can_read_library(...)`
--      raise `permission denied for schema templates` at policy-eval time
--      under the authenticated role. (service_role bypasses RLS so this
--      was previously latent — surfaces the moment a non-service_role
--      writes via the JSON API with RLS enforced.)
--
--   3. SELECT policy `templates_libraries_read_via_host` switched from
--      `templates.can_read_library(id)` to
--      `templates.can_read_host(host_kind, host_id)`.
--
--      Why: `can_read_library` re-queries templates_libraries inside a
--      SECURITY DEFINER STABLE function:
--        SELECT host_kind, host_id FROM templates_libraries WHERE id = $1
--      During an INSERT...RETURNING, the SELECT policy fires against the
--      just-written row, but the SECURITY DEFINER subselect runs with a
--      snapshot that does not see the new row, so FOUND=false and the
--      function returns false — denying the SELECT half of RETURNING and
--      manifesting as `42501 new row violates row-level security policy`.
--
--      `can_read_host(host_kind, host_id)` takes the columns directly from
--      the row being checked, so no self-table re-query is needed and the
--      RETURNING SELECT succeeds.
--
--      This issue only affects `templates_libraries` itself — for the other
--      templates_* tables, `can_read_library(library_id)` looks up an
--      already-committed parent row in templates_libraries, which the
--      SECURITY DEFINER snapshot does see, so they remain unchanged.
--
--      `templates_ab_tests_read_via_host` was already in the
--      `can_read_host(host_kind, host_id)` form in 005, so it is unaffected.
--
-- All three fixes were applied to the AAIF live DB via exec_sql during the
-- dogfood pass; this migration codifies them so they survive a fresh install.
-- ============================================================================

-- ==========================================================================
-- 1. Re-define dispatchers with regproc::text (drops the (uuid) arg list)
-- ==========================================================================

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

  v_oid := to_regprocedure(rtrim(v_can_fn, '()') || '(uuid)');
  IF v_oid IS NULL THEN
    RETURN false;
  END IF;

  -- regproc::text -> name only (e.g. "public.can_admin_site"),
  -- so format yields a well-formed `SELECT public.can_admin_site($1)`.
  v_sql := format('SELECT %s($1)', v_oid::regproc::text);
  EXECUTE v_sql INTO v_result USING v_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

COMMENT ON FUNCTION templates.can_read_library(uuid) IS
  'Dispatches to the host module''s permission helper via pages_host_registrations. Uses regproc::text (name only) so format(SELECT %s($1)) produces a well-formed call. Returns false if the host_kind is not registered, the can_admin_fn is missing/wrong-sig, or pages_host_registrations does not yet exist.';

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

  v_sql := format('SELECT %s($1)', v_oid::regproc::text);
  EXECUTE v_sql INTO v_result USING p_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

COMMENT ON FUNCTION templates.can_read_host(text, uuid) IS
  'Variant of can_read_library that takes (host_kind, host_id) directly — used by SELECT policies on tables where the just-inserted row holds those columns, avoiding the RETURNING-snapshot issue that affects can_read_library on templates_libraries itself.';

-- ==========================================================================
-- 2. Schema + execute grants for non-service_role policy evaluation
-- ==========================================================================
-- RLS policies that reference functions in the templates schema run under
-- the calling role (authenticated / anon). Without USAGE on the schema and
-- EXECUTE on the function, policy eval errors with `permission denied for
-- schema templates` before the SECURITY DEFINER body even runs.

GRANT USAGE ON SCHEMA templates TO authenticated, anon;
GRANT EXECUTE ON FUNCTION templates.can_read_library(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION templates.can_read_host(text, uuid) TO authenticated, anon;

-- ==========================================================================
-- 3. Switch templates_libraries SELECT policy to can_read_host
-- ==========================================================================
-- Only this one table is affected by the RETURNING-snapshot issue, because
-- only this dispatcher re-queries templates_libraries to find host_kind /
-- host_id. The other templates_* tables' SELECT policies use
-- can_read_library(library_id) where library_id points to an already-
-- committed parent row, so their SECURITY DEFINER subselect finds it.

DROP POLICY IF EXISTS "templates_libraries_read_via_host"
  ON public.templates_libraries;

CREATE POLICY "templates_libraries_read_via_host"
  ON public.templates_libraries
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

COMMENT ON POLICY "templates_libraries_read_via_host" ON public.templates_libraries IS
  'Reads templates_libraries when the caller can admin its host. Uses can_read_host(host_kind, host_id) — taking columns from the row directly — so INSERT...RETURNING does not hit the snapshot ordering issue that can_read_library(id) had (re-querying templates_libraries inside a SECURITY DEFINER STABLE function during the same statement that wrote the row).';
