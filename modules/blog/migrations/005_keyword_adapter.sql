-- ============================================================================
-- blog module — content-keywords adapter
-- Guarded: no-op if content-keywords isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_adapters'
  ) THEN
    RAISE NOTICE '[blog/005_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $migration$;

CREATE OR REPLACE FUNCTION public.blog_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH p AS (SELECT * FROM public.blog_posts WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(title, '')::text, NULL::text FROM p
  UNION ALL
  SELECT 'body'::text, COALESCE(content, '')::text, NULL::text FROM p
  UNION ALL
  SELECT 'excerpt'::text, COALESCE(excerpt, '')::text, NULL::text FROM p;
$$;

CREATE OR REPLACE FUNCTION public.blog_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('blog_post', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'delete', enqueued_at = now(), next_attempt_at = now(), attempts = 0, last_error = NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('blog_post', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'evaluate', enqueued_at = now(), next_attempt_at = now(), attempts = 0, last_error = NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS blog_ck_enqueue_trg ON public.blog_posts;
CREATE TRIGGER blog_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, content, excerpt OR DELETE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.blog_ck_enqueue();

CREATE OR REPLACE FUNCTION public.blog_posts_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_category_slug text DEFAULT NULL
) RETURNS SETOF public.blog_posts
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT bp.* FROM public.blog_posts bp
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'blog_post' AND s.content_id = bp.id
  LEFT JOIN public.blog_categories bc ON bc.id = bp.category_id
  WHERE bp.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='blog_post'),
                 true) = true
    AND (p_category_slug IS NULL OR bc.slug = p_category_slug)
  ORDER BY bp.published_at DESC NULLS LAST, bp.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

CREATE OR REPLACE FUNCTION public.blog_posts_public_get(p_slug text)
RETURNS SETOF public.blog_posts
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT bp.* FROM public.blog_posts bp
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'blog_post' AND s.content_id = bp.id
  WHERE bp.slug = p_slug AND bp.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='blog_post'),
                 true) = true;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.blog_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.blog_posts_public_list(int, int, text) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.blog_posts_public_get(text) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.blog_posts, public.blog_categories TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.blog_posts_public_list(int, int, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.blog_posts_public_list(int, int, text) TO anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.blog_posts_public_get(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.blog_posts_public_get(text) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'blog_post',
    'public.blog_keyword_text(uuid)'::regprocedure,
    'public.blog_posts'::regclass,
    'created_at',
    ARRAY['title','body','excerpt'],
    false,
    'Blog Post',
    true,
    ARRAY[
      'public.blog_posts_public_list(int,int,text)'::regprocedure,
      'public.blog_posts_public_get(text)'::regprocedure
    ]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'blog_post', id, 'evaluate' FROM public.blog_posts
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
