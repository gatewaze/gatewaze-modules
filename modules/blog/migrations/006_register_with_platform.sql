-- ============================================================================
-- blog — register with content-platform.
-- Defines inbox preview, registers as publish + category adapter. The
-- publish_state column + its index are created up-front in 001_blog_tables.
--
-- Soft-guarded: skips registration cleanly if content-platform isn't installed.
-- ============================================================================

-- Inbox preview.
CREATE OR REPLACE FUNCTION public.blog_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT b.title::text,
         NULLIF(LEFT(COALESCE(b.excerpt, b.meta_description, ''), 140), '')::text,
         COALESCE(b.featured_image, b.og_image)::text
  FROM public.blog_posts b WHERE b.id = p_id;
$$;
ALTER FUNCTION public.blog_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[blog/005] content-platform not installed; skipping registration';
    RETURN;
  END IF;

  PERFORM public.register_content_type(
    p_content_type      => 'blog_post',
    p_table_name        => 'public.blog_posts'::regclass,
    p_display_label     => 'Blog Post',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.blog_inbox_preview(uuid)'::regprocedure
  );

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='content_category_adapters') THEN
    -- blog_posts has no content_category column today; skip category adapter.
    -- Modules that want it should ALTER TABLE … ADD COLUMN content_category text first.
    NULL;
  END IF;
END $register$;
