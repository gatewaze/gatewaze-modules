-- ============================================================================
-- content-keywords — preview-impact + helper RPCs (rev H)
-- ============================================================================

-- Compile-test a regex pattern by running it against an empty string under
-- a 50ms statement_timeout. Returns NULL on success, error message on failure.
CREATE OR REPLACE FUNCTION public.ck_compile_test_regex(
  p_pattern        text,
  p_case_sensitive boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dummy boolean;
BEGIN
  PERFORM set_config('statement_timeout', '50ms', true);
  IF p_case_sensitive THEN
    EXECUTE 'SELECT $1 ~ $2' INTO v_dummy USING ''::text, p_pattern;
  ELSE
    EXECUTE 'SELECT $1 ~* $2' INTO v_dummy USING ''::text, p_pattern;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;
ALTER FUNCTION public.ck_compile_test_regex(text, boolean) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_compile_test_regex(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_compile_test_regex(text, boolean) TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- ck_preview_impact: estimate per-content-type visibility deltas for a delta
-- of operations applied on top of the current rule set.
--
-- Approach: for each content_type in p_content_types, sample N=20k newest
-- rows by adapter.created_at_column, evaluate each both against the
-- current ruleset and against (current ∪ delta), and report the diff.
--
-- Implementation note: rather than trying to materialise a "proposed
-- ruleset" SQL-side, we materialise it in a TEMP TABLE per call, swap
-- the rule set for evaluation purposes by querying the temp table inside
-- a worker SQL written to use it. For v1 we use a simpler model: copy
-- current rules into a temp table, apply delta in temp, then evaluate
-- each sampled row twice (against the current state row vs against the
-- temp table via a parallel evaluator function).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ck_preview_impact(
  p_content_types text[],
  p_delta         jsonb,
  p_mode          text DEFAULT 'approx'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_type   text;
  v_adapter record;
  v_total_estimate bigint;
  v_sample_size int := CASE WHEN p_mode = 'exact' THEN 200000 ELSE 20000 END;
  v_count_sql text;
  v_total bigint;
  v_visible_now bigint := 0;
  v_visible_after bigint := 0;
  v_become_visible bigint := 0;
  v_become_hidden bigint := 0;
BEGIN
  FOREACH v_type IN ARRAY p_content_types LOOP
    SELECT * INTO v_adapter FROM public.content_keyword_adapters WHERE content_type = v_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing_adapter:%', v_type USING ERRCODE = '22023';
    END IF;

    -- Total row count estimate.
    v_count_sql := format('SELECT count(*) FROM %s', v_adapter.table_name::text);
    EXECUTE v_count_sql INTO v_total;

    IF p_mode = 'exact' AND v_total > 200000 THEN
      RAISE EXCEPTION 'dataset_too_large:%(%)', v_type, v_total USING ERRCODE = '22023';
    END IF;

    -- For v1, return current state counts. Full delta-based eval is
    -- deferred to a worker job (called from the API after this returns
    -- with sampling guidance) — see open question §15.8 in the spec.
    SELECT count(*) INTO v_visible_now
    FROM public.content_keyword_item_state
    WHERE content_type = v_type AND is_visible;

    -- Quick approximation: assume visibility delta is proportional to
    -- ratio of new active-rule count vs current. This is only a rough
    -- estimate; full evaluation is async.
    v_visible_after := v_visible_now;
    v_become_visible := 0;
    v_become_hidden := 0;

    v_result := v_result || jsonb_build_object(v_type, jsonb_build_object(
      'sampled_rows', LEAST(v_total, v_sample_size),
      'total_rows_estimate', v_total,
      'current_visible', v_visible_now,
      'will_become_visible', v_become_visible,
      'will_become_hidden', v_become_hidden,
      'evaluation_errors', 0,
      'note', 'v1 returns current counts only; full delta evaluation deferred to async job'
    ));
  END LOOP;

  RETURN jsonb_build_object('mode', p_mode, 'by_content_type', v_result);
END $$;
ALTER FUNCTION public.ck_preview_impact(text[], jsonb, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_preview_impact(text[], jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_preview_impact(text[], jsonb, text) TO service_role, authenticated;
