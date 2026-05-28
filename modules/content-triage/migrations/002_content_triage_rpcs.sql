-- ============================================================================
-- Content Triage — core RPCs
-- All functions SECURITY DEFINER + owned by gatewaze_module_writer so they
-- bypass RLS (as table owner) and can write to the triage tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Shared: route matcher. Evaluates active routes against an item context and
-- returns the winning route row (highest priority). NULL if no match.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_match_route(
  p_content_type text,
  p_source       text,
  p_source_ref   text,
  p_categories   text[],
  p_metadata     jsonb
) RETURNS public.content_triage_routes
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_route public.content_triage_routes;
BEGIN
  SELECT r.* INTO v_route
  FROM public.content_triage_routes r
  WHERE r.active = true
    AND (r.content_type IS NULL OR r.content_type = p_content_type)
    AND (r.source       IS NULL OR r.source       = p_source)
    AND (r.category     IS NULL OR r.category = ANY(COALESCE(p_categories, '{}'::text[])))
    AND (r.source_ref_filter IS NULL OR p_source_ref ~ r.source_ref_filter)
    AND (r.metadata_filter IS NULL OR p_metadata @> r.metadata_filter)
  ORDER BY r.priority DESC, r.created_at ASC
  LIMIT 1;
  RETURN v_route;
END $$;

ALTER FUNCTION public.triage_match_route(text, text, text, text[], jsonb)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_match_route(text, text, text, text[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_match_route(text, text, text, text[], jsonb) TO authenticated;

-- ----------------------------------------------------------------------------
-- Shared: resolve recipient set for a route (single user OR team members).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_route_recipients(p_route_id uuid)
RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_route public.content_triage_routes;
BEGIN
  SELECT * INTO v_route FROM public.content_triage_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_route.assign_to IS NOT NULL THEN
    RETURN QUERY SELECT v_route.assign_to;
  ELSIF v_route.assign_to_team_name IS NOT NULL THEN
    RETURN QUERY
      SELECT m.user_id FROM public.content_triage_team_members m
      WHERE m.team_name = v_route.assign_to_team_name;
  END IF;
END $$;

ALTER FUNCTION public.triage_route_recipients(uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_route_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_route_recipients(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Shared: fan out notification rows from an item + route.
-- Idempotent via UNIQUE (item, lifecycle, recipient, channel, type).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_fanout_notifications(
  p_item_id           uuid,
  p_route_id          uuid,
  p_notification_type text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_route   public.content_triage_routes;
  v_item    public.content_triage_items;
  v_channel text;
  v_user    uuid;
  v_count   integer := 0;
BEGIN
  SELECT * INTO v_route FROM public.content_triage_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT * INTO v_item FROM public.content_triage_items WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR v_user IN SELECT user_id FROM public.triage_route_recipients(p_route_id) LOOP
    FOREACH v_channel IN ARRAY v_route.notify_channels LOOP
      BEGIN
        INSERT INTO public.content_triage_notifications (
          item_id, lifecycle_key, recipient_id, channel, notification_type
        ) VALUES (
          p_item_id, v_item.lifecycle_key, v_user, v_channel, p_notification_type
        );
        v_count := v_count + 1;
      EXCEPTION WHEN unique_violation THEN
        -- already queued for this (item, lifecycle, recipient, channel, type) — skip silently
        NULL;
      END;
    END LOOP;
  END LOOP;

  -- Wake delivery worker. pg_notify is best-effort; polling fallback covers miss.
  PERFORM pg_notify('triage_notify_pending', p_item_id::text);
  RETURN v_count;
END $$;

ALTER FUNCTION public.triage_fanout_notifications(uuid, uuid, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_fanout_notifications(uuid, uuid, text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- Shared: permission check. Actor can act on item if admin + (override OR
-- assigned_to matches OR team member).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_check_permission(
  p_actor_id uuid,
  p_item_id  uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_item public.content_triage_items;
BEGIN
  -- is_admin() runs in the caller's context via SET ROLE-style check; we
  -- fall back to conservative deny if the function isn't present (bootstrap).
  BEGIN
    IF NOT public.is_admin() THEN RETURN false; END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;

  SELECT * INTO v_item FROM public.content_triage_items WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Override permission (stubbed: admin is enough for v1; future: has_feature check)
  -- For v1, admin with assignee-match or team-member is the rule.
  IF v_item.assigned_to IS NOT DISTINCT FROM p_actor_id AND v_item.assigned_to IS NOT NULL THEN
    RETURN true;
  END IF;
  IF v_item.team_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.content_triage_team_members
    WHERE team_name = v_item.team_name AND user_id = p_actor_id
  ) THEN
    RETURN true;
  END IF;
  -- Unassigned items: any admin can claim/act.
  IF v_item.assigned_to IS NULL AND v_item.team_name IS NULL THEN
    RETURN true;
  END IF;

  RETURN false;
END $$;

ALTER FUNCTION public.triage_check_permission(uuid, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_check_permission(uuid, uuid) FROM PUBLIC;

-- ============================================================================
-- triage_submit — create a new triage item (or return existing active one).
-- Modes: auto_publish | auto_approve | review
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_submit(
  p_content_type         text,
  p_content_id           uuid,
  p_source               text,
  p_source_ref           text,
  p_mode                 text,              -- 'auto_publish' | 'auto_approve' | 'review'
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
  -- Idempotency check (only when a key was supplied).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_cached FROM public.content_triage_idempotency
    WHERE user_id = p_actor_id AND route = '/api/triage/items' AND key = p_idempotency_key;
    IF FOUND THEN
      IF v_cached.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
      END IF;
      -- Replay: unpack the cached body. item_id stored under 'itemId'.
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

  -- Existing active item?
  SELECT * INTO v_existing FROM public.content_triage_items
  WHERE content_type = p_content_type
    AND content_id   = p_content_id
    AND status IN ('pending','changes_requested')
  LIMIT 1;
  IF FOUND THEN
    status := 'already_pending';
    item_id := v_existing.id;
    lifecycle_key := v_existing.lifecycle_key;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Suggest categories if not supplied and adapter has suggest_fn.
  v_categories := p_suggested_categories;
  v_sug_from   := COALESCE(p_suggested_from, 'none');
  IF (v_categories IS NULL OR array_length(v_categories, 1) IS NULL) AND v_adapter.suggest_fn IS NOT NULL THEN
    BEGIN
      v_sql := format('SELECT categories, source FROM %s($1)', v_adapter.suggest_fn::text);
      EXECUTE v_sql INTO v_categories, v_sug_from USING p_content_id;
    EXCEPTION WHEN OTHERS THEN
      v_categories := '{}';
      v_sug_from := 'none';
    END;
  END IF;

  -- Apply route match to potentially override mode.
  v_route := public.triage_match_route(p_content_type, p_source, p_source_ref,
                                       v_categories, COALESCE(p_metadata, '{}'::jsonb));
  v_final_mode := COALESCE(v_route.mode_override, p_mode, 'review');

  IF v_final_mode = 'auto_publish' THEN
    -- Short-circuit: no triage row, call adapter's submit_fn if present.
    IF v_adapter.submit_fn IS NOT NULL THEN
      v_sql := format('SELECT %s($1, $2)', v_adapter.submit_fn::text);
      EXECUTE v_sql USING p_content_id, false;
    END IF;
    status := 'auto_published';
    item_id := NULL;
    lifecycle_key := NULL;
    -- Write idempotency row even on short-circuit.
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO public.content_triage_idempotency
        (user_id, route, key, request_hash, response_status, response_body)
      VALUES (p_actor_id, '/api/triage/items', p_idempotency_key, p_request_hash, 200,
              jsonb_build_object('status','auto_published'));
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Create the triage row (review or auto_approve).
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
    -- Call adapter approve_fn. Categories may be empty.
    v_sql := format('SELECT %s($1, $2, $3, $4)', v_adapter.approve_fn::text);
    EXECUTE v_sql USING p_content_id, COALESCE(v_categories, '{}'), false, p_actor_id;
    status := 'auto_approved';
  ELSE
    -- review: fire assigned notifications if route matched.
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

-- ============================================================================
-- triage_approve
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_approve(
  p_item_id             uuid,
  p_actor_id            uuid,
  p_expected_updated_at timestamptz,
  p_applied_categories  text[],
  p_featured            boolean,
  p_notes               text
) RETURNS TABLE(status text, item_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item    public.content_triage_items;
  v_adapter public.content_triage_adapters;
  v_sql     text;
BEGIN
  IF NOT public.triage_check_permission(p_actor_id, p_item_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.content_triage_items
  WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status <> 'pending' THEN RAISE EXCEPTION 'CONFLICT: status=%', v_item.status USING ERRCODE = 'P0003'; END IF;
  IF v_item.updated_at <> p_expected_updated_at THEN RAISE EXCEPTION 'CONFLICT: stale' USING ERRCODE = 'P0003'; END IF;

  SELECT * INTO v_adapter FROM public.content_triage_adapters WHERE content_type = v_item.content_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADAPTER_NOT_REGISTERED'; END IF;

  v_sql := format('SELECT %s($1, $2, $3, $4)', v_adapter.approve_fn::text);
  EXECUTE v_sql USING v_item.content_id, COALESCE(p_applied_categories, '{}'),
                      COALESCE(p_featured, false), p_actor_id;

  UPDATE public.content_triage_items
     SET status = 'approved',
         applied_categories = COALESCE(p_applied_categories, '{}'),
         is_featured = COALESCE(p_featured, false),
         review_notes = p_notes,
         reviewed_at = now(),
         reviewed_by = p_actor_id,
         updated_at = now()
   WHERE id = p_item_id
   RETURNING status, id, updated_at INTO status, item_id, updated_at;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reviewed', 'pending', 'approved', p_actor_id);

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_approve(uuid, uuid, timestamptz, text[], boolean, text) TO authenticated;

-- ============================================================================
-- triage_reject
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_reject(
  p_item_id             uuid,
  p_actor_id            uuid,
  p_expected_updated_at timestamptz,
  p_reason              text
) RETURNS TABLE(status text, item_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item    public.content_triage_items;
  v_adapter public.content_triage_adapters;
  v_sql     text;
BEGIN
  IF NOT public.triage_check_permission(p_actor_id, p_item_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.content_triage_items
  WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status <> 'pending' THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'P0003'; END IF;
  IF v_item.updated_at <> p_expected_updated_at THEN RAISE EXCEPTION 'CONFLICT: stale' USING ERRCODE = 'P0003'; END IF;

  SELECT * INTO v_adapter FROM public.content_triage_adapters WHERE content_type = v_item.content_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADAPTER_NOT_REGISTERED'; END IF;

  v_sql := format('SELECT %s($1, $2, $3)', v_adapter.reject_fn::text);
  EXECUTE v_sql USING v_item.content_id, COALESCE(p_reason, ''), p_actor_id;

  UPDATE public.content_triage_items
     SET status = 'rejected',
         reject_reason = p_reason,
         reviewed_at = now(),
         reviewed_by = p_actor_id,
         updated_at = now()
   WHERE id = p_item_id
   RETURNING status, id, updated_at INTO status, item_id, updated_at;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reviewed', 'pending', 'rejected', p_actor_id);

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_reject(uuid, uuid, timestamptz, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_reject(uuid, uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_reject(uuid, uuid, timestamptz, text) TO authenticated;

-- ============================================================================
-- triage_request_changes
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_request_changes(
  p_item_id             uuid,
  p_actor_id            uuid,
  p_expected_updated_at timestamptz,
  p_notes               text
) RETURNS TABLE(status text, item_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_item public.content_triage_items;
BEGIN
  IF NOT public.triage_check_permission(p_actor_id, p_item_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.content_triage_items
  WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status <> 'pending' THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'P0003'; END IF;
  IF v_item.updated_at <> p_expected_updated_at THEN RAISE EXCEPTION 'CONFLICT: stale' USING ERRCODE = 'P0003'; END IF;

  UPDATE public.content_triage_items
     SET status = 'changes_requested',
         review_notes = p_notes,
         reviewed_at = now(),
         reviewed_by = p_actor_id,
         updated_at = now()
   WHERE id = p_item_id
   RETURNING status, id, updated_at INTO status, item_id, updated_at;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reviewed', 'pending', 'changes_requested', p_actor_id);

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_request_changes(uuid, uuid, timestamptz, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_request_changes(uuid, uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_request_changes(uuid, uuid, timestamptz, text) TO authenticated;

-- ============================================================================
-- triage_assign
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_assign(
  p_item_id             uuid,
  p_actor_id            uuid,
  p_expected_updated_at timestamptz,
  p_assigned_to         uuid,
  p_team_name           text
) RETURNS TABLE(status text, item_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.triage_check_permission(p_actor_id, p_item_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Enforce XOR: exactly one target OR both null (unassign).
  IF p_assigned_to IS NOT NULL AND p_team_name IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: assigned_to and team_name are mutually exclusive' USING ERRCODE = '23514';
  END IF;

  UPDATE public.content_triage_items
     SET assigned_to = p_assigned_to,
         assigned_at = CASE WHEN p_assigned_to IS NOT NULL THEN now() ELSE NULL END,
         assigned_by = p_actor_id,
         team_name = p_team_name,
         updated_at = now()
   WHERE id = p_item_id AND updated_at = p_expected_updated_at
   RETURNING status, id, updated_at INTO status, item_id, updated_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'P0003'; END IF;

  INSERT INTO public.content_triage_events (item_id, event_type, actor_id, metadata)
  VALUES (p_item_id,
          CASE WHEN p_assigned_to IS NULL AND p_team_name IS NULL THEN 'unassigned' ELSE 'assigned' END,
          p_actor_id,
          jsonb_build_object('assigned_to', p_assigned_to, 'team_name', p_team_name));

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_assign(uuid, uuid, timestamptz, uuid, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_assign(uuid, uuid, timestamptz, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_assign(uuid, uuid, timestamptz, uuid, text) TO authenticated;

-- ============================================================================
-- triage_reopen — move changes_requested → pending, increment lifecycle_key
-- ============================================================================
CREATE OR REPLACE FUNCTION public.triage_reopen(
  p_item_id             uuid,
  p_actor_id            uuid,
  p_expected_updated_at timestamptz
) RETURNS TABLE(status text, item_id uuid, updated_at timestamptz, lifecycle_key integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_item public.content_triage_items;
BEGIN
  IF NOT public.triage_check_permission(p_actor_id, p_item_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item FROM public.content_triage_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status <> 'changes_requested' THEN RAISE EXCEPTION 'CONFLICT' USING ERRCODE = 'P0003'; END IF;
  IF v_item.updated_at <> p_expected_updated_at THEN RAISE EXCEPTION 'CONFLICT: stale' USING ERRCODE = 'P0003'; END IF;

  UPDATE public.content_triage_items
     SET status = 'pending',
         reviewed_at = NULL,
         reviewed_by = NULL,
         review_notes = NULL,
         lifecycle_key = lifecycle_key + 1,
         updated_at = now()
   WHERE id = p_item_id
   RETURNING status, id, updated_at, lifecycle_key
     INTO status, item_id, updated_at, lifecycle_key;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reopened', 'changes_requested', 'pending', p_actor_id);

  RETURN NEXT;
END $$;

ALTER FUNCTION public.triage_reopen(uuid, uuid, timestamptz) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.triage_reopen(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.triage_reopen(uuid, uuid, timestamptz) TO authenticated;
