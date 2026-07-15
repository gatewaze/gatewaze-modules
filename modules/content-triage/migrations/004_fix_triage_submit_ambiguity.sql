-- ============================================================================
-- content-triage — fix ambiguous "status" reference in triage_submit
--
-- The duplicate-pending check queried content_triage_items with an
-- unqualified "status", which collides with the function's OUT parameter of
-- the same name and raises 'column reference "status" is ambiguous' at
-- runtime — so EVERY triage submission failed once an adapter was registered
-- (callers like handle_keyword_verdict_change swallow the error). Re-creates
-- the function with the column qualified (fix also folded into 002 for fresh
-- installs).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.triage_submit(
  p_content_type         text,
  p_content_id           uuid,
  p_source               text,
  p_source_ref           text,
  p_mode                 text,
  p_suggested_categories text[],
  p_suggested_from       text,
  p_auto_approved_reason text,
  p_priority             smallint,
  p_metadata             jsonb,
  p_actor_id             uuid,
  p_idempotency_key      text,
  p_request_hash         bytea
) RETURNS TABLE(status text, item_id uuid, lifecycle_key integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing    public.content_triage_items;
  v_adapter     public.content_triage_adapters;
  v_route       public.content_triage_routes;
  v_new_id      uuid;
  v_sql         text;
  v_final_mode  text;
  v_cached      public.content_triage_idempotency;
  v_categories  text[];
  v_sug_from    text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_cached FROM public.content_triage_idempotency
    WHERE user_id = p_actor_id AND route = '/api/triage/items' AND key = p_idempotency_key;
    IF FOUND THEN
      IF v_cached.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
      END IF;
      RETURN QUERY
        SELECT v_cached.response_body->>'status',
               (v_cached.response_body->>'itemId')::uuid,
               COALESCE((v_cached.response_body->>'lifecycleKey')::integer, 1);
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_adapter FROM public.content_triage_adapters WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: no adapter for content_type=%', p_content_type USING ERRCODE = '23514';
  END IF;

  -- NB: alias + qualified columns are load-bearing — a bare "status" here is
  -- ambiguous against this function's OUT parameter and raises at runtime.
  SELECT cti.* INTO v_existing FROM public.content_triage_items cti
  WHERE cti.content_type = p_content_type
    AND cti.content_id   = p_content_id
    AND cti.status IN ('pending','changes_requested')
  LIMIT 1;
  IF FOUND THEN
    status := 'already_pending';
    item_id := v_existing.id;
    lifecycle_key := v_existing.lifecycle_key;
    RETURN NEXT;
    RETURN;
  END IF;

  v_categories := p_suggested_categories;
  v_sug_from   := COALESCE(p_suggested_from, 'none');
  IF (v_categories IS NULL OR array_length(v_categories, 1) IS NULL) AND v_adapter.suggest_fn IS NOT NULL THEN
    BEGIN
      v_sql := format('SELECT categories, source FROM %s($1)', v_adapter.suggest_fn::regproc::text);
      EXECUTE v_sql INTO v_categories, v_sug_from USING p_content_id;
    EXCEPTION WHEN OTHERS THEN
      v_categories := '{}';
      v_sug_from := 'none';
    END;
  END IF;

  v_route := public.triage_match_route(p_content_type, p_source, p_source_ref,
                                       v_categories, COALESCE(p_metadata, '{}'::jsonb));
  v_final_mode := COALESCE(v_route.mode_override, p_mode, 'review');

  IF v_final_mode = 'auto_publish' THEN
    IF v_adapter.submit_fn IS NOT NULL THEN
      v_sql := format('SELECT %s($1, $2)', v_adapter.submit_fn::regproc::text);
      EXECUTE v_sql USING p_content_id, false;
    END IF;
    status := 'auto_published';
    item_id := NULL;
    lifecycle_key := NULL;
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO public.content_triage_idempotency
        (user_id, route, key, request_hash, response_status, response_body)
      VALUES (p_actor_id, '/api/triage/items', p_idempotency_key, p_request_hash, 200,
              jsonb_build_object('status','auto_published'));
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.content_triage_items (
    content_type, content_id, source, source_ref,
    suggested_categories, suggested_from,
    applied_categories, status, priority,
    assigned_to, assigned_at, assigned_by, team_name,
    reviewed_at, reviewed_by,
    auto_approved_at, auto_approved_reason,
    metadata
  ) VALUES (
    p_content_type, p_content_id, p_source, p_source_ref,
    COALESCE(v_categories, '{}'),
    COALESCE(v_sug_from, 'none'),
    CASE WHEN v_final_mode = 'auto_approve' THEN COALESCE(v_categories, '{}') ELSE '{}' END,
    CASE WHEN v_final_mode = 'auto_approve' THEN 'approved' ELSE 'pending' END,
    COALESCE(p_priority, 50),
    v_route.assign_to,
    CASE WHEN v_route.assign_to IS NOT NULL THEN now() ELSE NULL END,
    NULL,
    v_route.assign_to_team_name,
    NULL, NULL,
    CASE WHEN v_final_mode = 'auto_approve' THEN now() ELSE NULL END,
    CASE WHEN v_final_mode = 'auto_approve' THEN COALESCE(p_auto_approved_reason, 'source:' || p_source) ELSE NULL END,
    COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING id INTO v_new_id;

  INSERT INTO public.content_triage_events (item_id, event_type, to_status, actor_id, metadata)
  VALUES (v_new_id, 'created', CASE WHEN v_final_mode = 'auto_approve' THEN 'approved' ELSE 'pending' END,
          p_actor_id, jsonb_build_object('mode', v_final_mode, 'route_id', v_route.id));

  IF v_final_mode = 'auto_approve' THEN
    v_sql := format('SELECT %s($1, $2, $3, $4)', v_adapter.approve_fn::regproc::text);
    EXECUTE v_sql USING p_content_id, COALESCE(v_categories, '{}'), false, p_actor_id;
    status := 'auto_approved';
  ELSE
    IF v_route.id IS NOT NULL THEN
      PERFORM public.triage_fanout_notifications(v_new_id, v_route.id, 'assigned');
    END IF;
    status := 'created';
  END IF;

  item_id := v_new_id;
  SELECT i.lifecycle_key INTO lifecycle_key FROM public.content_triage_items i WHERE i.id = v_new_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.content_triage_idempotency
      (user_id, route, key, request_hash, response_status, response_body)
    VALUES (p_actor_id, '/api/triage/items', p_idempotency_key, p_request_hash,
            CASE WHEN status = 'created' THEN 201 ELSE 200 END,
            jsonb_build_object('status', status, 'itemId', v_new_id, 'lifecycleKey', lifecycle_key));
  END IF;

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_submit(text, uuid, text, text, text, text[], text, text, smallint, jsonb, uuid, text, bytea) TO authenticated;

