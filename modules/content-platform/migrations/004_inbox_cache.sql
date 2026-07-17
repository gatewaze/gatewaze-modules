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
  v_state text;
  v_extra jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND OR v_adapter.inbox_preview_fn IS NULL THEN
    RETURN;
  END IF;

  -- inbox_preview_fn is a regprocedure whose text form carries the arg list
  -- ("events_inbox_preview(uuid)") — cast via regproc to get the bare
  -- callable name, else the format() below produces "fn(uuid)($1)".
  v_sql := format('SELECT title, subtitle, thumbnail_url FROM %s($1)',
                  v_adapter.inbox_preview_fn::oid::regproc::text);
  EXECUTE v_sql INTO v_row USING p_content_id;

  -- Live publish_state via the adapter registry (generic for every type).
  BEGIN
    EXECUTE format('SELECT %I FROM %s WHERE id = $1',
                   v_adapter.publish_state_col, v_adapter.table_name)
      INTO v_state USING p_content_id;
    IF v_state IS NOT NULL THEN
      v_extra := v_extra || jsonb_build_object('publish_state', v_state);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Event-specific fields the inbox sort/filter and portal link read.
  IF p_content_type = 'event' THEN
    BEGIN
      SELECT v_extra || jsonb_strip_nulls(jsonb_build_object(
               'event_start', e.event_start,
               'event_id',    e.event_id,
               'event_slug',  e.event_slug))
        INTO v_extra
        FROM public.events e WHERE e.id = p_content_id;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  UPDATE public.content_triage_items
    SET metadata = COALESCE(metadata, '{}'::jsonb) || v_extra || jsonb_build_object(
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
