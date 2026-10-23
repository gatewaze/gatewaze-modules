-- ============================================================================
-- blog — retry the content-triage and content-platform registrations
-- ============================================================================
-- On some databases blog_post was never registered with content-triage
-- (004) or content-platform (006):
--   - Databases baselined from another one (LF dev, copied from AAIF prod)
--     recorded 004 and 006 as applied while their guarded registration
--     blocks had skipped, because the platform modules weren't there yet,
--     and a module migration never runs twice.
--   - register_content_type() runs its internal
--     GRANT SELECT, UPDATE (publish_state) ON blog_posts as
--     gatewaze_module_writer. That role does not own blog_posts and has no
--     grant option on it, so the call can fail with 42501 (the same gap
--     event-sponsors/003 closes for events_sponsors).
-- Either way, handle_keyword_verdict_change raises "unregistered
-- content_type: blog_post", triage_submit fails its content_type check, and
-- feed-scraped posts in pending_review never reach the Content Inbox.
--
-- This migration makes sure publish_state and rejection_reason exist (older
-- baselined tables may predate them), takes anon and authenticated off the
-- blog adapter functions, pre-grants the writer role as the table owner and
-- gives it an RLS policy on blog_posts, then re-runs both registrations.
-- Each step is guarded and idempotent (ADD COLUMN IF NOT EXISTS, DROP/CREATE
-- POLICY, ON CONFLICT DO UPDATE, register_content_type's upsert), so it is a
-- no-op where everything is already in place.
-- ============================================================================

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published';
-- 001 folded rejection_reason in for the triage adapter; tables that predate
-- that (LF dev) lack it, and blog_triage_reject writes it.
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS rejection_reason text;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.blog_posts'::regclass
       AND conname = 'blog_posts_publish_state_check'
  ) THEN
    ALTER TABLE public.blog_posts ADD CONSTRAINT blog_posts_publish_state_check
      CHECK (publish_state IN
        ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));
  END IF;
END
$check$;

-- The blog adapter functions are SECURITY DEFINER and owned by
-- gatewaze_module_writer. They are only meant to be called by content-triage's
-- triage_* RPCs and the inbox cache (both run as that owner) and by the API
-- with the service role. 004 and 006 never revoked them, and on Supabase the
-- default privileges grant EXECUTE to anon and authenticated directly, so a
-- REVOKE FROM PUBLIC alone is not enough. Close that before the RLS policy
-- below lets these functions see unpublished rows.
DO $acl$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.blog_triage_approve(uuid, text[], boolean, uuid)',
    'public.blog_triage_reject(uuid, text, uuid)',
    'public.blog_triage_submit(uuid, boolean)',
    'public.blog_triage_suggest_categories(uuid)',
    'public.blog_inbox_preview(uuid)',
    'public.blog_keyword_text(uuid)'
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

DO $grant$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  -- As the table owner, so register_content_type's internal re-grant
  -- succeeds whichever role owns that function (see event-sponsors/003).
  -- UPDATE is limited to the columns the triage adapter and the publish
  -- state machine write.
  GRANT SELECT ON public.blog_posts TO gatewaze_module_writer WITH GRANT OPTION;
  GRANT UPDATE (status, publish_state, category_id, content_category, rejection_reason)
    ON public.blog_posts TO gatewaze_module_writer WITH GRANT OPTION;
  -- blog_posts carries the emit_mutation_event trigger, which runs as the
  -- updating role and reads webhook_event_topics. Without this, every
  -- triage approve/reject (run as this role) fails with 42501.
  IF to_regclass('public.webhook_event_topics') IS NOT NULL THEN
    GRANT SELECT ON public.webhook_event_topics TO gatewaze_module_writer;
  END IF;
  -- Same as 004: lets ALTER ... OWNER TO succeed on Supabase Cloud, where
  -- postgres is not a true superuser.
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END
$grant$;

-- The writer role does not bypass RLS on every database (LF dev), and
-- blog_posts had no policy for it, so its SECURITY DEFINER functions (the
-- verdict handler, inbox preview, triage approve/reject) saw zero rows.
--
-- A policy lets every writer-owned SECURITY DEFINER function see unpublished
-- posts, so it is only safe once nothing anon or authenticated can call
-- reaches them. The $acl$ block above covers the blog functions. The
-- dispatchers that call them (content-triage's triage_*, content-platform's
-- publish-state and registry RPCs) are revoked by content-triage/005 and
-- content-platform/011; blog does not depend on content-triage, so its
-- migrations may run first, and the block below repeats those revokes
-- (idempotent). The policy is then created only if the check still passes.
DO $dispatch$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea)',
    'public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text)',
    'public.triage_reject(uuid, uuid, timestamptz, text)',
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
$dispatch$;


DO $policy$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea)',
        'public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text)',
        'public.triage_reject(uuid, uuid, timestamptz, text)',
        'public.content_publish_state_set(text, uuid, text, text, text)',
        'public.blog_triage_approve(uuid, text[], boolean, uuid)'
      ]) AS f(sig)
      CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
     WHERE to_regprocedure(f.sig) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role)
       AND has_function_privilege(r.role, to_regprocedure(f.sig), 'EXECUTE')
  ) THEN
    RAISE NOTICE '[blog/011] a triage dispatcher is still callable by anon or authenticated; skipping the blog_posts writer policy';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS blog_posts_module_writer ON public.blog_posts;
  CREATE POLICY blog_posts_module_writer ON public.blog_posts
    FOR SELECT TO gatewaze_module_writer USING (true);
  DROP POLICY IF EXISTS blog_posts_module_writer_update ON public.blog_posts;
  CREATE POLICY blog_posts_module_writer_update ON public.blog_posts
    FOR UPDATE TO gatewaze_module_writer USING (true) WITH CHECK (true);
END
$policy$;

DO $triage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[blog/011] content-triage not installed; skipping triage registration';
    RETURN;
  END IF;

  ALTER FUNCTION public.blog_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.blog_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.blog_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.blog_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'blog_post',
    'public.blog_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.blog_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.blog_triage_suggest_categories(uuid)'::regprocedure,
    'public.blog_triage_submit(uuid,boolean)'::regprocedure,
    'Blog Post'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$triage$;

DO $platform$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_publish_adapters'
  ) THEN
    RAISE NOTICE '[blog/011] content-platform not installed; skipping publish registration';
    RETURN;
  END IF;

  PERFORM public.register_content_type(
    p_content_type      => 'blog_post',
    p_table_name        => 'public.blog_posts'::regclass,
    p_display_label     => 'Blog Post',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.blog_inbox_preview(uuid)'::regprocedure
  );
END
$platform$;
