-- ============================================================================
-- blog — triage adapter
-- Extends blog_posts.status with pending_review/rejected + triage RPCs.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[blog/004_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.blog_posts'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    ALTER TABLE public.blog_posts DROP CONSTRAINT IF EXISTS blog_posts_status_check;
    ALTER TABLE public.blog_posts ADD CONSTRAINT blog_posts_status_check
      CHECK (status IN ('draft','published','archived','pending_review','rejected'));
  END IF;

  ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

CREATE OR REPLACE FUNCTION public.blog_triage_approve(
  p_content_id  uuid,
  p_categories  text[],
  p_featured    boolean,
  p_reviewer    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category_id uuid;
BEGIN
  IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 THEN
    SELECT id INTO v_category_id FROM public.blog_categories WHERE slug = p_categories[1] LIMIT 1;
  END IF;

  UPDATE public.blog_posts
     SET status = 'published',
         category_id = COALESCE(v_category_id, category_id),
         content_category = COALESCE(p_categories[1], content_category)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blog post % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.blog_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.blog_posts
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blog post % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.blog_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Prefer existing content_category, fall back to blog_categories FK.
  RETURN QUERY
    SELECT ARRAY[bp.content_category]::text[], 'content_category'::text
    FROM public.blog_posts bp
    WHERE bp.id = p_content_id AND bp.content_category IS NOT NULL
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT ARRAY[bc.slug]::text[], 'blog_category'::text
    FROM public.blog_posts bp
    JOIN public.blog_categories bc ON bc.id = bp.category_id
    WHERE bp.id = p_content_id
    LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION public.blog_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.blog_posts
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.blog_posts
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','published','archived');
  END IF;
END $$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);

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
$register$;
