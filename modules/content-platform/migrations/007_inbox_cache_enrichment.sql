-- ============================================================================
-- content-platform — inbox cache enrichment + auto-refresh on triage submit
--
-- Inbox rows created by the verdict-handler pipeline rendered "untitled"
-- with no event date: nothing called refresh_inbox_cache after
-- triage_submit, and the cache only carried title/subtitle/thumbnail
-- anyway — the list API also reads metadata.publish_state /
-- metadata.event_start / metadata.event_slug, which only the legacy
-- insert path ever populated.
--
-- 1. refresh_inbox_cache now also caches the row's live publish_state
--    (generic, via the adapter's table/column) and, for events, the
--    event_start / event_id / event_slug fields the inbox sort, the
--    upcoming/past filter, and the portal link rely on.
-- 2. handle_keyword_verdict_change refreshes the cache right after
--    submitting to triage, so new items render fully from the start.
-- ============================================================================

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

CREATE OR REPLACE FUNCTION public.handle_keyword_verdict_change(
  p_content_type text,
  p_content_id   uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter         content_publish_adapters;
  v_is_visible      boolean;
  v_current_state   text;
  v_new_state       text;
  v_triage_outcome  jsonb := NULL;
  v_has_keywords    boolean;
  v_has_triage      boolean;
  v_sql             text;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unregistered content_type: %', p_content_type
      USING ERRCODE='42P01';
  END IF;

  v_has_keywords := EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_keyword_item_state'
  );
  v_has_triage := EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_triage_adapters'
  );

  IF v_has_keywords THEN
    SELECT is_visible INTO v_is_visible
      FROM public.content_keyword_item_state
      WHERE content_type = p_content_type AND content_id = p_content_id;
  END IF;
  v_is_visible := COALESCE(v_is_visible, true);

  v_sql := format('SELECT %I FROM %s WHERE id = $1 FOR UPDATE',
                  v_adapter.publish_state_col, v_adapter.table_name);
  EXECUTE v_sql INTO v_current_state USING p_content_id;
  IF v_current_state IS NULL THEN
    RAISE EXCEPTION 'content row not found: %.%', p_content_type, p_content_id
      USING ERRCODE='P0002';
  END IF;

  IF NOT v_is_visible THEN
    IF v_current_state IN ('pending_review','published') THEN
      v_new_state := 'auto_suppressed';
    ELSE
      v_new_state := v_current_state;
    END IF;
  ELSE
    IF v_current_state = 'auto_suppressed' THEN
      v_new_state := 'pending_review';
    ELSE
      v_new_state := v_current_state;
    END IF;
  END IF;

  IF v_new_state IS DISTINCT FROM v_current_state THEN
    PERFORM public.content_publish_state_set(
      p_content_type, p_content_id, v_new_state, 'system:keyword',
      format('verdict=%s', v_is_visible));
  END IF;

  IF v_new_state = 'pending_review' AND v_has_triage THEN
    BEGIN
      SELECT to_jsonb(t) INTO v_triage_outcome FROM public.triage_submit(
        p_content_type => p_content_type,
        p_content_id   => p_content_id,
        p_source       => 'keyword_verdict',
        p_source_ref   => format('verdict:%s:%s', p_content_type, p_content_id),
        p_mode         => 'review',
        p_suggested_categories => NULL,
        p_suggested_from       => NULL,
        p_auto_approved_reason => NULL,
        p_priority             => 50::smallint,
        p_metadata             => jsonb_build_object('via','keyword_verdict'),
        p_actor_id             => NULL,
        p_idempotency_key      => NULL,
        p_request_hash         => NULL
      ) t;
    EXCEPTION WHEN OTHERS THEN
      v_triage_outcome := jsonb_build_object('error', SQLERRM);
    END;
    -- Populate the inbox preview cache (title/subtitle/thumbnail/event
    -- fields) immediately so new triage rows never render "untitled".
    BEGIN
      PERFORM public.refresh_inbox_cache(p_content_type, p_content_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'from_state', v_current_state,
    'to_state',   v_new_state,
    'triage',     v_triage_outcome
  );
END $$;
ALTER FUNCTION public.handle_keyword_verdict_change(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.handle_keyword_verdict_change(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_keyword_verdict_change(text, uuid) TO service_role;
