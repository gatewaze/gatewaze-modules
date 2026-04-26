-- ============================================================================
-- events module — register with content-platform.
-- Defines events_inbox_preview() and registers as a publish + category adapter.
-- ============================================================================

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_publish_adapters'
  ) THEN
    RAISE NOTICE '[events/008_register_with_platform] content-platform not installed; skipping';
    RETURN;
  END IF;
END $migration$;

-- Per-row preview returned in the inbox listing.
CREATE OR REPLACE FUNCTION public.events_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT
    e.event_title::text,
    NULLIF(
      concat_ws(' · ',
        NULLIF(e.event_city, ''),
        NULLIF(e.event_country_code, ''),
        to_char(e.event_start, 'YYYY-MM-DD')
      ),
      ''
    )::text,
    COALESCE(e.event_logo, e.screenshot_url)::text
  FROM public.events e
  WHERE e.id = p_id;
$$;
ALTER FUNCTION public.events_inbox_preview(uuid) OWNER TO gatewaze_module_writer;
GRANT EXECUTE ON FUNCTION public.events_inbox_preview(uuid) TO service_role;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_publish_adapters'
  ) THEN RETURN; END IF;

  PERFORM public.register_content_type(
    p_content_type      => 'event',
    p_table_name        => 'public.events'::regclass,
    p_display_label     => 'Event',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.events_inbox_preview(uuid)'::regprocedure
  );

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_category_adapters'
  ) THEN
    PERFORM public.register_category_adapter(
      p_content_type => 'event',
      p_table_name   => 'public.events'::regclass,
      p_category_col => 'content_category'
    );
  END IF;
END $register$;
