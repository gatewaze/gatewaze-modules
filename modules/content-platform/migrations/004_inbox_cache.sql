-- ============================================================================
-- content-platform — inbox preview cache helper.
-- See spec-unified-content-management.md §8.8.
-- ============================================================================

-- Refresh cached title/subtitle/thumbnail for any open triage item targeting
-- this content. Called by per-content-type UPDATE paths (events_update, etc.).
CREATE OR REPLACE FUNCTION public.refresh_inbox_cache(
  p_content_type text,
  p_content_id   uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter content_publish_adapters;
  v_sql text;
  v_row record;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND OR v_adapter.inbox_preview_fn IS NULL THEN
    RETURN;
  END IF;

  v_sql := format('SELECT title, subtitle, thumbnail_url FROM %s($1)',
                  v_adapter.inbox_preview_fn::text);
  EXECUTE v_sql INTO v_row USING p_content_id;

  UPDATE public.content_triage_items
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'title', v_row.title,
      'subtitle', v_row.subtitle,
      'thumbnail_url', v_row.thumbnail_url,
      'preview_refreshed_at', now()
    )
    WHERE content_type = p_content_type
      AND content_id = p_content_id
      AND status IN ('pending','changes_requested');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'refresh_inbox_cache failed for %.%: %', p_content_type, p_content_id, SQLERRM;
END $$;
ALTER FUNCTION public.refresh_inbox_cache(text, uuid) OWNER TO gatewaze_module_writer;
GRANT EXECUTE ON FUNCTION public.refresh_inbox_cache(text, uuid) TO service_role;
