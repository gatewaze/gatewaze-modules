-- ============================================================================
-- content-platform — publish state registry, central setter, verdict handler
-- See spec-unified-content-management.md §3.1, §8.5.3, §8.5.4, §8.5.6.
-- ============================================================================

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $bootstrap$;

-- ----------------------------------------------------------------------------
-- The adapter registry. Every content type that wants publish_state gating
-- registers itself here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.content_publish_adapters (
  content_type      text PRIMARY KEY,
  table_name        regclass NOT NULL,
  publish_state_col text NOT NULL DEFAULT 'publish_state',
  display_label     text NOT NULL,
  inbox_preview_fn  regprocedure,
  registered_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_publish_adapters OWNER TO gatewaze_module_writer;

-- ----------------------------------------------------------------------------
-- Audit log of every state transition.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.content_publish_state_audit (
  id           bigserial PRIMARY KEY,
  content_type text NOT NULL,
  content_id   uuid NOT NULL,
  from_state   text,
  to_state     text NOT NULL,
  actor        text NOT NULL,
  reason       text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_publish_state_audit_lookup
  ON public.content_publish_state_audit (content_type, content_id, occurred_at DESC);
ALTER TABLE public.content_publish_state_audit OWNER TO gatewaze_module_writer;

-- ----------------------------------------------------------------------------
-- Verdict-change queue. Drained by the verdict-handler worker.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.content_publish_state_event_queue (
  id              bigserial PRIMARY KEY,
  content_type    text NOT NULL,
  content_id      uuid NOT NULL,
  trigger         text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts        smallint NOT NULL DEFAULT 0,
  last_error      text,
  dead_letter_at  timestamptz,
  dead_letter_reason text
);
CREATE INDEX IF NOT EXISTS content_publish_state_event_queue_next
  ON public.content_publish_state_event_queue (next_attempt_at)
  WHERE dead_letter_at IS NULL;
CREATE INDEX IF NOT EXISTS content_publish_state_event_queue_lookup
  ON public.content_publish_state_event_queue (content_type, content_id);
ALTER TABLE public.content_publish_state_event_queue OWNER TO gatewaze_module_writer;

-- ----------------------------------------------------------------------------
-- Central guarded setter. Validates state transitions per the closed state
-- machine. All UPDATEs to any registered publish_state column MUST go through
-- this function.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.content_publish_state_set(
  p_content_type text,
  p_content_id   uuid,
  p_to           text,
  p_actor        text,
  p_reason       text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter content_publish_adapters;
  v_from    text;
  v_valid   boolean;
  v_sql     text;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unregistered content_type: %', p_content_type
      USING ERRCODE='42P01';
  END IF;

  v_sql := format('SELECT %I FROM %s WHERE id = $1 FOR UPDATE',
                  v_adapter.publish_state_col, v_adapter.table_name);
  EXECUTE v_sql INTO v_from USING p_content_id;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'content row not found: %.%', p_content_type, p_content_id
      USING ERRCODE='P0002';
  END IF;

  v_valid := CASE
    WHEN v_from = p_to THEN true
    WHEN v_from = 'draft'           AND p_to IN ('pending_review','published')                       THEN true
    WHEN v_from = 'pending_review'  AND p_to IN ('auto_suppressed','published','rejected')           THEN true
    WHEN v_from = 'published'       AND p_to IN ('auto_suppressed','unpublished','pending_review')   THEN true
    WHEN v_from = 'auto_suppressed' AND p_to IN ('pending_review','published')                       THEN true
    WHEN v_from = 'rejected'        AND p_to IN ('pending_review')                                   THEN true
    WHEN v_from = 'unpublished'     AND p_to IN ('published')                                        THEN true
    ELSE false
  END;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION: %.% % -> %',
      p_content_type, p_content_id, v_from, p_to USING ERRCODE='23514';
  END IF;

  IF v_from IS DISTINCT FROM p_to THEN
    v_sql := format('UPDATE %s SET %I = $1 WHERE id = $2',
                    v_adapter.table_name, v_adapter.publish_state_col);
    EXECUTE v_sql USING p_to, p_content_id;
    INSERT INTO public.content_publish_state_audit
      (content_type, content_id, from_state, to_state, actor, reason)
    VALUES (p_content_type, p_content_id, v_from, p_to, p_actor, p_reason);
    IF v_from = 'published' AND p_to = 'auto_suppressed' AND p_actor = 'system:keyword' THEN
      RAISE WARNING 'keyword_overrode_admin_publish: %.%', p_content_type, p_content_id;
    END IF;
  END IF;
END $$;
ALTER FUNCTION public.content_publish_state_set(text, uuid, text, text, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_publish_state_set(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_publish_state_set(text, uuid, text, text, text) TO service_role;

-- ----------------------------------------------------------------------------
-- Atomic verdict-change handler. Worker calls this with (content_type, content_id);
-- it reads the latest keyword verdict, locks the content row, applies any state
-- change via content_publish_state_set, and submits a triage row when needed.
-- All in one transaction.
-- ----------------------------------------------------------------------------
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
        p_priority             => 50,
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

-- ----------------------------------------------------------------------------
-- register_content_type — atomic upsert across the four adapter registries.
-- Validates the underlying table per spec §8.4 before registering.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_content_type(
  p_content_type      text,
  p_table_name        regclass,
  p_display_label     text,
  p_publish_state_col text DEFAULT 'publish_state',
  p_inbox_preview_fn  regprocedure DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_table_oid   oid;
  v_col_exists  boolean;
  v_col_type    text;
BEGIN
  v_table_oid := p_table_name::oid;

  -- Validate id column is uuid.
  SELECT format_type(atttypid, atttypmod) INTO v_col_type
    FROM pg_attribute
    WHERE attrelid = v_table_oid AND attname = 'id' AND NOT attisdropped;
  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'table % must have an "id" column', p_table_name;
  END IF;
  IF v_col_type <> 'uuid' THEN
    RAISE EXCEPTION 'table %.id must be uuid (got %)', p_table_name, v_col_type;
  END IF;

  -- Validate publish_state column exists.
  SELECT format_type(atttypid, atttypmod) INTO v_col_type
    FROM pg_attribute
    WHERE attrelid = v_table_oid AND attname = p_publish_state_col AND NOT attisdropped;
  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'table % missing publish_state column %',
      p_table_name, p_publish_state_col;
  END IF;
  IF v_col_type NOT IN ('text','character varying') THEN
    RAISE EXCEPTION 'column %.% must be text-typed (got %)',
      p_table_name, p_publish_state_col, v_col_type;
  END IF;

  -- Validate inbox_preview_fn signature if provided.
  -- Match by argument TYPES (not names): pg_get_function_identity_arguments
  -- returns "p_id uuid" for a function declared `(p_id uuid)` — including the
  -- parameter name — so a literal equality check against 'uuid' rejects every
  -- function that names its argument. Compare against proargtypes instead so
  -- both `(uuid)` and `(p_id uuid)` are accepted.
  IF p_inbox_preview_fn IS NOT NULL THEN
    PERFORM 1 FROM pg_proc
      WHERE oid = p_inbox_preview_fn::oid
        AND pronargs = 1
        AND proargtypes[0] = 'uuid'::regtype;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inbox_preview_fn % must take a single uuid arg', p_inbox_preview_fn;
    END IF;
  END IF;

  INSERT INTO public.content_publish_adapters
    (content_type, table_name, publish_state_col, display_label, inbox_preview_fn)
  VALUES
    (p_content_type, p_table_name, p_publish_state_col, p_display_label, p_inbox_preview_fn)
  ON CONFLICT (content_type) DO UPDATE SET
    table_name        = EXCLUDED.table_name,
    publish_state_col = EXCLUDED.publish_state_col,
    display_label     = EXCLUDED.display_label,
    inbox_preview_fn  = EXCLUDED.inbox_preview_fn;

  -- Grant the publish_state setter (which runs as gatewaze_module_writer via
  -- SECURITY DEFINER) UPDATE permission on the registered column. Without
  -- this, content_publish_state_set raises 42501 on every transition.
  EXECUTE format(
    'GRANT SELECT, UPDATE (%I) ON %s TO gatewaze_module_writer',
    p_publish_state_col, p_table_name
  );

  RETURN jsonb_build_object(
    'content_type', p_content_type,
    'table_name', p_table_name::text,
    'publish_state_col', p_publish_state_col,
    'display_label', p_display_label,
    'inbox_preview_fn', p_inbox_preview_fn::text
  );
END $$;
ALTER FUNCTION public.register_content_type(text, regclass, text, text, regprocedure)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.register_content_type(text, regclass, text, text, regprocedure) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_content_type(text, regclass, text, text, regprocedure) TO service_role;

-- ----------------------------------------------------------------------------
-- unregister_content_type — safety-checked removal from registry.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unregister_content_type(
  p_content_type text,
  p_force        boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter content_publish_adapters;
  v_open    int;
  v_sql     text;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('content_type', p_content_type, 'status', 'not_registered');
  END IF;

  IF NOT p_force THEN
    v_sql := format('SELECT count(*) FROM %s WHERE %I IN (''pending_review'',''auto_suppressed'')',
                    v_adapter.table_name, v_adapter.publish_state_col);
    EXECUTE v_sql INTO v_open;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'cannot unregister %: % open items in pending_review/auto_suppressed; pass p_force=>true to override',
        p_content_type, v_open;
    END IF;
  END IF;

  DELETE FROM public.content_publish_adapters WHERE content_type = p_content_type;

  UPDATE public.content_publish_state_event_queue
    SET dead_letter_at = COALESCE(dead_letter_at, now()),
        dead_letter_reason = COALESCE(dead_letter_reason, 'content_type_unregistered')
    WHERE content_type = p_content_type AND dead_letter_at IS NULL;

  INSERT INTO public.content_publish_state_audit
    (content_type, content_id, from_state, to_state, actor, reason)
  VALUES (p_content_type, '00000000-0000-0000-0000-000000000000'::uuid,
          NULL, '__unregistered__', 'system:unregister',
          format('p_force=%s', p_force));

  RETURN jsonb_build_object('content_type', p_content_type, 'status', 'unregistered');
END $$;
ALTER FUNCTION public.unregister_content_type(text, boolean) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.unregister_content_type(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unregister_content_type(text, boolean) TO service_role;
