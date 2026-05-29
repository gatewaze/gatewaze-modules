-- ============================================================================
-- content-keywords — RPCs (rev H)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ck_evaluate_inner: pure evaluator. Calls adapter text_fn, evaluates active
-- in-scope rules, returns (is_visible, matched_rule_ids).
-- ----------------------------------------------------------------------------
-- 3-OUT form with tier_rank (was 004_metadata_and_tier_rank): also computes
-- the highest tier_rank across matched rules from each rule's metadata.
CREATE OR REPLACE FUNCTION public.ck_evaluate_inner(
  p_content_type text,
  p_content_id   uuid,
  OUT v_is_visible    boolean,
  OUT v_matched       uuid[],
  OUT v_tier_rank     int
) RETURNS record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adapter    record;
  v_default    boolean;
  r_rule       record;
  v_text_rec   record;
  v_match      boolean;
  v_text_query text;
  v_pattern    text;
  v_op         text;
  v_rule_rank  int;
BEGIN
  v_matched := ARRAY[]::uuid[];
  v_tier_rank := NULL;

  SELECT * INTO v_adapter FROM public.content_keyword_adapters
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing_adapter:%', p_content_type USING ERRCODE = '22023';
  END IF;
  v_default := v_adapter.default_visible_when_no_rules;

  IF NOT EXISTS (
    SELECT 1 FROM public.content_keyword_rules
    WHERE p_content_type = ANY(content_types) AND is_active
  ) THEN
    v_is_visible := v_default;
    RETURN;
  END IF;

  FOR r_rule IN
    SELECT * FROM public.content_keyword_rules
    WHERE p_content_type = ANY(content_types) AND is_active
    ORDER BY id
  LOOP
    v_match := false;
    v_pattern := r_rule.pattern;
    v_op := CASE r_rule.pattern_type
      WHEN 'substring' THEN CASE WHEN r_rule.case_sensitive THEN 'pos' ELSE 'pos_ci' END
      WHEN 'word'      THEN CASE WHEN r_rule.case_sensitive THEN 'word_cs' ELSE 'word_ci' END
      WHEN 'regex'     THEN CASE WHEN r_rule.case_sensitive THEN 'regex_cs' ELSE 'regex_ci' END
    END;

    v_text_query := format(
      'SELECT field, value, source FROM %s($1) WHERE value IS NOT NULL AND value <> %L',
      v_adapter.text_fn::regproc::text, '');
    FOR v_text_rec IN EXECUTE v_text_query USING p_content_id LOOP
      IF r_rule.sources IS NOT NULL THEN
        IF v_text_rec.source IS NULL OR NOT (v_text_rec.source = ANY(r_rule.sources)) THEN
          CONTINUE;
        END IF;
      END IF;
      IF r_rule.fields <> ARRAY['any'] THEN
        IF NOT (v_text_rec.field = ANY(r_rule.fields)) THEN
          CONTINUE;
        END IF;
      END IF;

      v_match := CASE v_op
        WHEN 'pos'      THEN position(v_pattern in v_text_rec.value) > 0
        WHEN 'pos_ci'   THEN position(lower(v_pattern) in lower(v_text_rec.value)) > 0
        WHEN 'word_cs'  THEN v_text_rec.value ~  ('\m' || regexp_replace(v_pattern, '([.\^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
        WHEN 'word_ci'  THEN v_text_rec.value ~* ('\m' || regexp_replace(v_pattern, '([.\^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
        WHEN 'regex_cs' THEN v_text_rec.value ~  v_pattern
        WHEN 'regex_ci' THEN v_text_rec.value ~* v_pattern
      END;

      IF v_match THEN
        v_matched := v_matched || r_rule.id;
        -- Pick up tier_rank from the rule's metadata, track max.
        v_rule_rank := NULLIF(r_rule.metadata->>'tier_rank', '')::int;
        IF v_rule_rank IS NOT NULL AND (v_tier_rank IS NULL OR v_rule_rank > v_tier_rank) THEN
          v_tier_rank := v_rule_rank;
        END IF;
        EXIT;
      END IF;
    END LOOP;

    IF array_length(v_matched, 1) >= 50 THEN EXIT; END IF;
  END LOOP;

  v_matched := ARRAY(SELECT unnest(v_matched) ORDER BY 1);
  v_is_visible := COALESCE(array_length(v_matched, 1), 0) > 0;
END $$;
ALTER FUNCTION public.ck_evaluate_inner(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_evaluate_inner(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_evaluate_inner(text, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_evaluate_item: writes evaluation result to content_keyword_item_state.
-- ----------------------------------------------------------------------------
-- Writes the verdict and (was 005_emit_verdict_changes) enqueues a
-- content_publish_state_event_queue row on first eval or visibility transition
-- so the events verdict-handler propagates is_visible into publish_state.
CREATE OR REPLACE FUNCTION public.ck_evaluate_item(
  p_content_type text,
  p_content_id   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version       bigint;
  v_eval          record;
  v_prev_visible  boolean;
  v_has_queue     boolean;
BEGIN
  SELECT version INTO v_version
  FROM public.content_keyword_ruleset_versions
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN v_version := 1; END IF;

  -- Snapshot prior state so we can detect transitions.
  SELECT is_visible INTO v_prev_visible
    FROM public.content_keyword_item_state
   WHERE content_type = p_content_type AND content_id = p_content_id;

  SELECT * INTO v_eval FROM public.ck_evaluate_inner(p_content_type, p_content_id);

  INSERT INTO public.content_keyword_item_state
    (content_type, content_id, is_visible, matched_rule_ids, evaluated_at, ruleset_version)
  VALUES (p_content_type, p_content_id, v_eval.v_is_visible, v_eval.v_matched, now(), v_version)
  ON CONFLICT (content_type, content_id) DO UPDATE
    SET is_visible       = EXCLUDED.is_visible,
        matched_rule_ids = EXCLUDED.matched_rule_ids,
        evaluated_at     = EXCLUDED.evaluated_at,
        ruleset_version  = EXCLUDED.ruleset_version;

  -- Emit a verdict-change event when:
  --   - first evaluation (v_prev_visible IS NULL), or
  --   - transition between true/false.
  v_has_queue := EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_state_event_queue'
  );

  IF v_has_queue AND (v_prev_visible IS NULL OR v_prev_visible IS DISTINCT FROM v_eval.v_is_visible) THEN
    INSERT INTO public.content_publish_state_event_queue
      (content_type, content_id, trigger, payload)
    VALUES (
      p_content_type, p_content_id, 'keyword_verdict',
      jsonb_build_object('is_visible', v_eval.v_is_visible,
                         'previous',   v_prev_visible)
    );
  END IF;
END $$;
ALTER FUNCTION public.ck_evaluate_item(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_evaluate_item(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_evaluate_item(text, uuid) TO service_role;

-- Install the universal category-sync trigger if content-platform is present
-- (was 005_emit_verdict_changes). content-platform also installs it but skips
-- if content_keyword_item_state didn't exist yet at that time.
DO $trg$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cm_category_sync_universal') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS cm_category_sync_universal_trg ON public.content_keyword_item_state';
    EXECUTE 'CREATE TRIGGER cm_category_sync_universal_trg
             AFTER INSERT OR UPDATE OF matched_rule_ids ON public.content_keyword_item_state
             FOR EACH ROW EXECUTE FUNCTION public.cm_category_sync_universal()';
  END IF;
END $trg$;

-- ----------------------------------------------------------------------------
-- ck_drain_queue: returns up to N due rows, locking them via SKIP LOCKED.
-- The worker then processes each and either deletes or increments attempts.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_drain_queue(p_batch_size int DEFAULT 200)
RETURNS TABLE(content_type text, content_id uuid, op text, attempts int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT q.content_type, q.content_id, q.op, q.attempts
  FROM public.content_keyword_match_queue q
  WHERE q.next_attempt_at <= now()
  ORDER BY q.enqueued_at ASC
  LIMIT p_batch_size
  FOR UPDATE SKIP LOCKED;
END $$;
ALTER FUNCTION public.ck_drain_queue(int) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_drain_queue(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_drain_queue(int) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_complete_queue_row: called by worker after successful evaluate or delete.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_complete_queue_row(
  p_content_type text,
  p_content_id   uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.content_keyword_match_queue
  WHERE content_type = p_content_type AND content_id = p_content_id;
$$;
ALTER FUNCTION public.ck_complete_queue_row(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_complete_queue_row(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_complete_queue_row(text, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_fail_queue_row: increments attempts; moves to DLQ after 5 attempts.
-- Backoff: 1s, 5s, 30s, 2min, 10min.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_fail_queue_row(
  p_content_type text,
  p_content_id   uuid,
  p_error        text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts  int;
  v_backoff   interval;
  v_row       record;
BEGIN
  SELECT * INTO v_row FROM public.content_keyword_match_queue
  WHERE content_type = p_content_type AND content_id = p_content_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_attempts := v_row.attempts + 1;
  IF v_attempts >= 5 THEN
    INSERT INTO public.content_keyword_match_queue_dlq
      (content_type, content_id, op, enqueued_at, attempts, last_error)
      VALUES (v_row.content_type, v_row.content_id, v_row.op, v_row.enqueued_at, v_attempts, p_error)
      ON CONFLICT (content_type, content_id) DO UPDATE SET
        op = EXCLUDED.op,
        enqueued_at = EXCLUDED.enqueued_at,
        attempts = EXCLUDED.attempts,
        last_error = EXCLUDED.last_error,
        failed_at = now();
    DELETE FROM public.content_keyword_match_queue
    WHERE content_type = p_content_type AND content_id = p_content_id;
  ELSE
    v_backoff := CASE v_attempts
      WHEN 1 THEN interval '1 second'
      WHEN 2 THEN interval '5 seconds'
      WHEN 3 THEN interval '30 seconds'
      WHEN 4 THEN interval '2 minutes'
      ELSE        interval '10 minutes'
    END;
    UPDATE public.content_keyword_match_queue
    SET attempts = v_attempts,
        last_error = p_error,
        next_attempt_at = now() + v_backoff
    WHERE content_type = p_content_type AND content_id = p_content_id;
  END IF;

  -- Always log to eval_errors for observability.
  INSERT INTO public.content_keyword_eval_errors
    (content_type, content_id, error_code, error_message)
  VALUES (p_content_type, p_content_id, 'eval_failed', left(p_error, 1000));
END $$;
ALTER FUNCTION public.ck_fail_queue_row(text, uuid, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_fail_queue_row(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_fail_queue_row(text, uuid, text) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_acquire_recompute_lease / renew / release
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_acquire_recompute_lease(
  p_content_type text,
  p_job_id uuid,
  p_ttl interval DEFAULT interval '2 minutes'
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_acquired boolean;
BEGIN
  INSERT INTO public.content_keyword_recompute_leases (content_type, job_id, expires_at)
  VALUES (p_content_type, p_job_id, now() + p_ttl)
  ON CONFLICT (content_type) DO UPDATE
    SET job_id = EXCLUDED.job_id,
        acquired_at = now(),
        expires_at = EXCLUDED.expires_at
    WHERE public.content_keyword_recompute_leases.expires_at < now()
  RETURNING (job_id = p_job_id) INTO v_acquired;
  RETURN COALESCE(v_acquired, false);
END $$;
ALTER FUNCTION public.ck_acquire_recompute_lease(text, uuid, interval) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_acquire_recompute_lease(text, uuid, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_acquire_recompute_lease(text, uuid, interval) TO service_role;

CREATE OR REPLACE FUNCTION public.ck_renew_recompute_lease(
  p_content_type text, p_job_id uuid, p_ttl interval DEFAULT interval '2 minutes'
) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.content_keyword_recompute_leases
  SET expires_at = now() + p_ttl
  WHERE content_type = p_content_type AND job_id = p_job_id;
$$;
ALTER FUNCTION public.ck_renew_recompute_lease(text, uuid, interval) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_renew_recompute_lease(text, uuid, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_renew_recompute_lease(text, uuid, interval) TO service_role;

CREATE OR REPLACE FUNCTION public.ck_release_recompute_lease(
  p_content_type text, p_job_id uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.content_keyword_recompute_leases
  WHERE content_type = p_content_type AND job_id = p_job_id;
$$;
ALTER FUNCTION public.ck_release_recompute_lease(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_release_recompute_lease(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_release_recompute_lease(text, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_request_recompute: insert a job row, return its id.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_request_recompute(
  p_content_types text[],
  p_rule_ids      uuid[] DEFAULT NULL,
  p_trigger       text   DEFAULT 'manual',
  p_force         boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id   uuid;
  v_existing uuid;
BEGIN
  -- Conflict check: any pending/running job for any requested type.
  IF NOT p_force THEN
    SELECT id INTO v_existing FROM public.content_keyword_recompute_jobs
    WHERE status IN ('pending','running')
      AND content_types && p_content_types
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RAISE EXCEPTION 'recompute_in_progress:%', v_existing USING ERRCODE = '55006';
    END IF;
  END IF;

  INSERT INTO public.content_keyword_recompute_jobs
    (trigger, rule_ids, content_types, status)
    VALUES (p_trigger, p_rule_ids, p_content_types, 'pending')
    RETURNING id INTO v_job_id;
  RETURN v_job_id;
END $$;
ALTER FUNCTION public.ck_request_recompute(text[], uuid[], text, boolean) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_request_recompute(text[], uuid[], text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_request_recompute(text[], uuid[], text, boolean) TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- AFTER trigger on rules: when a rule changes, automatically request recompute.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ckr_request_recompute_on_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_types text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_types := NEW.content_types;
  ELSIF TG_OP = 'DELETE' THEN
    affected_types := OLD.content_types;
  ELSE
    -- Only on visibility-affecting changes (mirror version-bump trigger).
    IF NEW.pattern        IS NOT DISTINCT FROM OLD.pattern
       AND NEW.pattern_type   IS NOT DISTINCT FROM OLD.pattern_type
       AND NEW.case_sensitive IS NOT DISTINCT FROM OLD.case_sensitive
       AND NEW.content_types  IS NOT DISTINCT FROM OLD.content_types
       AND NEW.sources        IS NOT DISTINCT FROM OLD.sources
       AND NEW.fields         IS NOT DISTINCT FROM OLD.fields
       AND NEW.is_active      IS NOT DISTINCT FROM OLD.is_active
    THEN
      RETURN NEW;
    END IF;
    affected_types := ARRAY(SELECT DISTINCT unnest(OLD.content_types || NEW.content_types));
  END IF;

  -- Best-effort enqueue; ignore conflict (existing job will pick up changes
  -- once it sees the new ruleset_version, OR a follow-up scan-stale catches it).
  BEGIN
    PERFORM public.ck_request_recompute(
      p_content_types := affected_types,
      p_rule_ids      := ARRAY[COALESCE(NEW.id, OLD.id)],
      p_trigger       := 'rule_change',
      p_force         := false
    );
  EXCEPTION WHEN OTHERS THEN
    -- Already running; the staleness scanner will catch up.
    NULL;
  END;

  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS ckr_request_recompute_trg ON public.content_keyword_rules;
CREATE TRIGGER ckr_request_recompute_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.content_keyword_rules
  FOR EACH ROW EXECUTE FUNCTION public.ckr_request_recompute_on_change();

-- ----------------------------------------------------------------------------
-- ck_scan_stale_and_missing: enqueues stale + missing-state items per type.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_scan_stale_and_missing(
  p_content_type text,
  p_batch_size int DEFAULT 1000
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adapter   record;
  v_current   bigint;
  v_enqueued  int := 0;
  v_sql       text;
BEGIN
  SELECT * INTO v_adapter FROM public.content_keyword_adapters
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT version INTO v_current FROM public.content_keyword_ruleset_versions
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN v_current := 1; END IF;

  -- Stale items.
  WITH stale AS (
    SELECT s.content_type, s.content_id
    FROM public.content_keyword_item_state s
    WHERE s.content_type = p_content_type
      AND s.ruleset_version < v_current
    ORDER BY s.evaluated_at ASC
    LIMIT p_batch_size
  )
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT content_type, content_id, 'evaluate' FROM stale
  ON CONFLICT (content_type, content_id) DO UPDATE
    SET op = 'evaluate', enqueued_at = now(), next_attempt_at = now(), attempts = 0, last_error = NULL;
  GET DIAGNOSTICS v_enqueued = ROW_COUNT;

  -- Missing-state items via dynamic SQL on adapter.table_name.
  v_sql := format($f$
    WITH missing AS (
      SELECT b.id
      FROM %s b
      LEFT JOIN public.content_keyword_item_state s
        ON s.content_type = %L AND s.content_id = b.id
      WHERE s.content_id IS NULL
      LIMIT %s
    )
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
    SELECT %L, id, 'evaluate' FROM missing
    ON CONFLICT (content_type, content_id) DO NOTHING
  $f$, v_adapter.table_name::text, p_content_type, p_batch_size, p_content_type);
  EXECUTE v_sql;

  RETURN v_enqueued;
END $$;
ALTER FUNCTION public.ck_scan_stale_and_missing(text, int) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_scan_stale_and_missing(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_scan_stale_and_missing(text, int) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_break_stale_leases: marks recompute jobs as failed if heartbeat/lease lost.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_break_stale_leases() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  WITH stale AS (
    SELECT j.id, j.content_types
    FROM public.content_keyword_recompute_jobs j
    WHERE j.status = 'running'
      AND (j.heartbeat_at IS NULL OR j.heartbeat_at < now() - interval '3 minutes')
  ), upd AS (
    UPDATE public.content_keyword_recompute_jobs j
    SET status = 'failed',
        error_message = 'lease_expired',
        finished_at = now()
    FROM stale WHERE j.id = stale.id
    RETURNING j.id, j.content_types
  )
  DELETE FROM public.content_keyword_recompute_leases l
  USING upd WHERE l.job_id = upd.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
ALTER FUNCTION public.ck_break_stale_leases() OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_break_stale_leases() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_break_stale_leases() TO service_role;

-- ----------------------------------------------------------------------------
-- ck_refresh_adapter_stats: refresh count cache for one (or all) content types.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_refresh_adapter_stats(p_content_type text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adapter record;
  v_current bigint;
  v_total   bigint;
  v_visible bigint;
  v_stale   bigint;
  v_sql     text;
BEGIN
  FOR v_adapter IN
    SELECT * FROM public.content_keyword_adapters
    WHERE p_content_type IS NULL OR content_type = p_content_type
  LOOP
    SELECT version INTO v_current FROM public.content_keyword_ruleset_versions
    WHERE content_type = v_adapter.content_type;
    v_current := COALESCE(v_current, 1);

    v_sql := format('SELECT count(*) FROM %s', v_adapter.table_name::text);
    EXECUTE v_sql INTO v_total;

    SELECT count(*) FILTER (WHERE is_visible),
           count(*) FILTER (WHERE ruleset_version < v_current)
      INTO v_visible, v_stale
      FROM public.content_keyword_item_state
      WHERE content_type = v_adapter.content_type;

    INSERT INTO public.content_keyword_adapter_stats
      (content_type, current_total_count, current_visible_count, stale_state_count, refreshed_at)
    VALUES (v_adapter.content_type, v_total, COALESCE(v_visible, 0), COALESCE(v_stale, 0), now())
    ON CONFLICT (content_type) DO UPDATE
      SET current_total_count = EXCLUDED.current_total_count,
          current_visible_count = EXCLUDED.current_visible_count,
          stale_state_count = EXCLUDED.stale_state_count,
          refreshed_at = EXCLUDED.refreshed_at;
  END LOOP;
END $$;
ALTER FUNCTION public.ck_refresh_adapter_stats(text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_refresh_adapter_stats(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_refresh_adapter_stats(text) TO service_role;

-- ----------------------------------------------------------------------------
-- ck_is_visible: convenience for low-volume admin tooling. NOT for hot paths.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_is_visible(p_content_type text, p_content_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT is_visible FROM public.content_keyword_item_state
     WHERE content_type = p_content_type AND content_id = p_content_id),
    (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters
     WHERE content_type = p_content_type),
    true
  );
$$;
ALTER FUNCTION public.ck_is_visible(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_is_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_is_visible(text, uuid) TO service_role, authenticated;
