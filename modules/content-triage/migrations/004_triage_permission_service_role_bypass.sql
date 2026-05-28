-- =====================================================================
-- Module: content-triage
-- Migration: 004_triage_permission_service_role_bypass
-- =====================================================================
-- Two production bugs blocking the admin Content Inbox approve / reject
-- flow, both originating in 002:
--
-- 1. triage_check_permission (gate for triage_approve / triage_reject /
--    triage_request_changes / triage_reopen / triage_assign) calls
--    public.is_admin() first. is_admin() reads auth.uid() against
--    admin_profiles, but the api server connects with the
--    SUPABASE_SERVICE_ROLE_KEY and that JWT carries role=service_role
--    with no `sub` claim — so auth.uid() is null inside the RPC and
--    is_admin() returns false. Every approve from /api/admin/inbox/bulk
--    raised FORBIDDEN. Treat service_role as the trusted server-to-server
--    channel; the api is responsible for verifying the calling admin at
--    the HTTP layer before it invokes these RPCs. The user-context path
--    (authenticated JWT with sub) keeps its existing is_admin() +
--    assignment / team rules.
--
--    Implementation note: triage_check_permission runs SECURITY DEFINER
--    as gatewaze_module_writer, which does not have USAGE on the auth
--    schema, so calling auth.role() directly raises "permission denied
--    for schema auth" and falls into the EXCEPTION block. Read the JWT
--    claims via current_setting('request.jwt.claims') instead — that's
--    what auth.role() does under the hood and it works regardless of
--    schema grants.
--
-- 2. triage_submit / triage_approve / triage_reject dispatch to per-
--    content-type adapter functions via dynamic SQL:
--      v_sql := format('SELECT %s($1, ...)', v_adapter.approve_fn::text);
--    `approve_fn` etc. are typed `regprocedure`, and casting
--    regprocedure to text yields the *full* signature, e.g.
--    `events_triage_approve(uuid,text[],boolean,uuid)`. Splicing that
--    into a SELECT produces:
--      SELECT events_triage_approve(uuid,text[],boolean,uuid)($1,...)
--    which fails with `syntax error at or near "]"`. Cast through
--    `regproc` (function name only) to fix all five callsites.
--
-- We rewrite the three RPCs in full because CREATE OR REPLACE FUNCTION
-- cannot patch a single line. Bodies are otherwise identical to 002.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) triage_check_permission — service_role bypass
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.triage_check_permission(
  p_actor_id uuid,
  p_item_id  uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item   public.content_triage_items;
  v_claims jsonb;
BEGIN
  -- Service-role calls come from the trusted api server.
  BEGIN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    IF v_claims->>'role' = 'service_role' THEN RETURN true; END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- User-context path: must be an admin.
  BEGIN
    IF NOT public.is_admin() THEN RETURN false; END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;

  SELECT * INTO v_item FROM public.content_triage_items WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_item.assigned_to IS NOT DISTINCT FROM p_actor_id AND v_item.assigned_to IS NOT NULL THEN
    RETURN true;
  END IF;
  IF v_item.team_name IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.content_triage_team_members
    WHERE team_name = v_item.team_name AND user_id = p_actor_id
  ) THEN
    RETURN true;
  END IF;
  IF v_item.assigned_to IS NULL AND v_item.team_name IS NULL THEN
    RETURN true;
  END IF;

  RETURN false;
END $$;

-- ---------------------------------------------------------------------
-- (2) triage_submit — fix ::regproc casts on suggest_fn / submit_fn / approve_fn
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- (3) triage_approve — fix ::regproc cast on approve_fn
-- ---------------------------------------------------------------------
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

  v_sql := format('SELECT %s($1, $2, $3, $4)', v_adapter.approve_fn::regproc::text);
  EXECUTE v_sql USING v_item.content_id, COALESCE(p_applied_categories, '{}'),
                      COALESCE(p_featured, false), p_actor_id;

  -- Alias the table so RETURNING clauses can disambiguate from the OUT
  -- parameters (status / item_id / updated_at).
  UPDATE public.content_triage_items AS t
     SET status = 'approved',
         applied_categories = COALESCE(p_applied_categories, '{}'),
         is_featured = COALESCE(p_featured, false),
         review_notes = p_notes,
         reviewed_at = now(),
         reviewed_by = p_actor_id,
         updated_at = now()
   WHERE t.id = p_item_id
   RETURNING t.status, t.id, t.updated_at INTO status, item_id, updated_at;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reviewed', 'pending', 'approved', p_actor_id);

  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------
-- (4) triage_reject — fix ::regproc cast on reject_fn
-- ---------------------------------------------------------------------
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

  v_sql := format('SELECT %s($1, $2, $3)', v_adapter.reject_fn::regproc::text);
  EXECUTE v_sql USING v_item.content_id, COALESCE(p_reason, ''), p_actor_id;

  UPDATE public.content_triage_items AS t
     SET status = 'rejected',
         reject_reason = p_reason,
         reviewed_at = now(),
         reviewed_by = p_actor_id,
         updated_at = now()
   WHERE t.id = p_item_id
   RETURNING t.status, t.id, t.updated_at INTO status, item_id, updated_at;

  INSERT INTO public.content_triage_events (item_id, event_type, from_status, to_status, actor_id)
  VALUES (p_item_id, 'reviewed', 'pending', 'rejected', p_actor_id);

  RETURN NEXT;
END $$;
