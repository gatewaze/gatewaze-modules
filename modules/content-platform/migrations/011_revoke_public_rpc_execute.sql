-- ============================================================================
-- content-platform — take the publish-state and registry RPCs off anon and
-- authenticated
-- ============================================================================
-- Supabase's default privileges grant EXECUTE on every new public function
-- directly to anon and authenticated, so the earlier REVOKE ... FROM PUBLIC
-- left these SECURITY DEFINER functions callable by anyone through PostgREST.
-- Several do not check the caller at all (triage_submit trusts its p_mode,
-- content_publish_state_set and register_content_type have no guard), and
-- every legitimate caller uses the service role (the module APIs and the
-- verdict worker) or calls them from another SECURITY DEFINER function as
-- the owner. Revoke from PUBLIC, anon
-- and authenticated; grant service_role. Idempotent.
-- ============================================================================

DO $acl$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.content_publish_state_set(text, uuid, text, text, text)',
    'public.handle_keyword_verdict_change(text, uuid)',
    'public.register_content_type(text, regclass, text, text, regprocedure)',
    'public.unregister_content_type(text, boolean)',
    'public.refresh_inbox_cache(text, uuid)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;
END
$acl$;
