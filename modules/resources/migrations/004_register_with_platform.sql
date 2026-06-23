-- ============================================================================
-- structured-resources — register sr_item with content-platform.
-- ============================================================================

-- The publish_state column + its index are created up-front in
-- 001_structured_resources.

CREATE OR REPLACE FUNCTION public.sr_items_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT i.title::text,
         NULLIF(i.subtitle, '')::text,
         i.featured_image_url::text
  FROM public.sr_items i WHERE i.id = p_id;
$$;
ALTER FUNCTION public.sr_items_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[structured-resources/003] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'sr_item',
    p_table_name        => 'public.sr_items'::regclass,
    p_display_label     => 'Structured Resource Item',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.sr_items_inbox_preview(uuid)'::regprocedure
  );
END $register$;
