-- ============================================================================
-- blog 011 + 012 test. Run against a database with the blog, content-triage
-- and content-platform migrations applied. Everything happens inside one
-- transaction that is rolled back, so it is safe on a dev database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/blog/__tests__/sql/triage-publish-state.test.sql
--
-- Any failed assertion raises and stops the script.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_id    uuid;
  v_state text;
  v_status text;
  v_denied boolean;
BEGIN
  -- 011: blog_post is registered with both registries.
  IF NOT EXISTS (SELECT 1 FROM public.content_triage_adapters WHERE content_type = 'blog_post') THEN
    RAISE EXCEPTION 'blog_post missing from content_triage_adapters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.content_publish_adapters WHERE content_type = 'blog_post') THEN
    RAISE EXCEPTION 'blog_post missing from content_publish_adapters';
  END IF;

  INSERT INTO public.blog_posts (title, slug, author_id, status, publish_state)
  VALUES ('Triage test', 'blog-012-triage-test', '00000000-0000-4000-8000-000000000012',
          'pending_review', 'pending_review')
  RETURNING id INTO v_id;

  -- 012: approve publishes both columns.
  PERFORM public.blog_triage_approve(v_id, NULL, false, NULL);
  SELECT status, publish_state INTO v_status, v_state FROM public.blog_posts WHERE id = v_id;
  IF v_status <> 'published' OR v_state <> 'published' THEN
    RAISE EXCEPTION 'approve: got status=% publish_state=%', v_status, v_state;
  END IF;

  -- 012: reopening a live post sends both columns back to review.
  PERFORM public.blog_triage_submit(v_id, true);
  SELECT status, publish_state INTO v_status, v_state FROM public.blog_posts WHERE id = v_id;
  IF v_status <> 'pending_review' OR v_state <> 'pending_review' THEN
    RAISE EXCEPTION 'submit(reopen): got status=% publish_state=%', v_status, v_state;
  END IF;

  -- 012: reject marks both columns rejected.
  PERFORM public.blog_triage_reject(v_id, 'test', NULL);
  SELECT status, publish_state INTO v_status, v_state FROM public.blog_posts WHERE id = v_id;
  IF v_status <> 'rejected' OR v_state <> 'rejected' THEN
    RAISE EXCEPTION 'reject: got status=% publish_state=%', v_status, v_state;
  END IF;

  -- 012: anon and authenticated can no longer call the adapter functions.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    IF has_function_privilege('anon', 'public.blog_triage_approve(uuid,text[],boolean,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.blog_triage_reject(uuid,text,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.blog_triage_submit(uuid,boolean)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.blog_triage_suggest_categories(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.blog_inbox_preview(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.blog_keyword_text(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'anon still has EXECUTE on a blog_triage_* function';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', 'public.blog_triage_approve(uuid,text[],boolean,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated still has EXECUTE on blog_triage_approve';
  END IF;
  -- 011: the writer role can see blog_posts under RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.blog_posts'::regclass
                  AND polname = 'blog_posts_module_writer') THEN
    RAISE EXCEPTION 'blog_posts_module_writer policy missing';
  END IF;
  -- The content-triage dispatchers run as the owner, which keeps EXECUTE.
  IF NOT has_function_privilege('gatewaze_module_writer', 'public.blog_triage_approve(uuid,text[],boolean,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'gatewaze_module_writer lost EXECUTE on blog_triage_approve';
  END IF;
END
$$;

-- A real call as anon must be refused, not just reported by the catalog.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN RETURN; END IF;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.blog_triage_approve('00000000-0000-4000-8000-000000000000'::uuid, NULL, false, NULL);
    RAISE EXCEPTION 'anon call to blog_triage_approve was not refused';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END
$$;

ROLLBACK;
