-- ============================================================================
-- content-platform/011 + content-triage/005 test: the publish-state, registry
-- and triage RPCs are not callable by anon or authenticated. Run against a
-- database with both modules installed. Everything is rolled back.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/content-platform/__tests__/sql/rpc-execute.test.sql
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_sig  text;
  v_role text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea)',
    'public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text)',
    'public.triage_reject(uuid, uuid, timestamptz, text)',
    'public.content_publish_state_set(text, uuid, text, text, text)',
    'public.handle_keyword_verdict_change(text, uuid)',
    'public.register_content_type(text, regclass, text, text, regprocedure)',
    'public.unregister_content_type(text, boolean)',
    'public.refresh_inbox_cache(text, uuid)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'function missing: %', v_sig;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
         AND has_function_privilege(v_role, to_regprocedure(v_sig), 'EXECUTE') THEN
        RAISE EXCEPTION '% can still EXECUTE %', v_role, v_sig;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lost EXECUTE on %', v_sig;
    END IF;
  END LOOP;
END
$$;

-- A real call as authenticated must be refused: triage_submit trusts its
-- p_mode, so this is the path that could auto-approve content.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN RETURN; END IF;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.triage_submit(
      p_content_type => 'blog_post',
      p_content_id   => '00000000-0000-4000-8000-000000000000'::uuid,
      p_source       => 'test',
      p_source_ref   => NULL,
      p_mode         => 'auto_approve',
      p_suggested_categories => ARRAY['x'],
      p_suggested_from       => NULL,
      p_auto_approved_reason => NULL,
      p_priority             => 50::smallint,
      p_metadata             => '{}'::jsonb,
      p_actor_id             => NULL,
      p_idempotency_key      => NULL,
      p_request_hash         => NULL);
    RAISE EXCEPTION 'authenticated call to triage_submit was not refused';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END
$$;

ROLLBACK;
