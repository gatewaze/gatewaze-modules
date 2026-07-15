-- ============================================================================
-- content-platform — fix triage submission from handle_keyword_verdict_change
--
-- The triage_submit call passed p_priority => 50 (integer) but triage_submit
-- declares p_priority smallint. Named-argument resolution has no implicit
-- int->smallint conversion, so the call raised "function ... does not exist"
-- — swallowed by the surrounding EXCEPTION block and returned as
-- {"triage": {"error": ...}}. Net effect: content entering pending_review via
-- the verdict handler (including all scraper-created events with
-- default_publish_state='pending_review') NEVER reached the Content Inbox.
--
-- Re-creates the function with the literal cast to smallint (fix also folded
-- into 001 for fresh installs).
-- ============================================================================

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
