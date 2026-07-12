-- ============================================================================
-- videos — register with content-platform (publish + category adapters).
-- Soft-guarded: skips cleanly if content-platform isn't installed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.videos_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT v.title::text,
         NULLIF(LEFT(COALESCE(v.description, v.channel_title, ''), 140), '')::text,
         v.thumbnail_url::text
  FROM public.videos v WHERE v.id = p_id;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    EXECUTE 'ALTER FUNCTION public.videos_inbox_preview(uuid) OWNER TO gatewaze_module_writer';
  END IF;
END $$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[videos/002] content-platform not installed; skipping registration';
    RETURN;
  END IF;

  PERFORM public.register_content_type(
    p_content_type      => 'video',
    p_table_name        => 'public.videos'::regclass,
    p_display_label     => 'Video',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.videos_inbox_preview(uuid)'::regprocedure
  );

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='content_category_adapters') THEN
    PERFORM public.register_category_adapter(
      p_content_type => 'video',
      p_table_name   => 'public.videos'::regclass,
      p_category_col => 'content_category'
    );
  END IF;
END $register$;
