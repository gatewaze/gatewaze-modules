-- ============================================================================
-- Module: segments
-- Migration: 014_calc_batch_and_test_exclusion
-- Description: Two fixes for large-audience materialisation.
--
-- 1. TIMEOUT. segments_calculate_members INSERTs the whole audience in one pass;
--    for ~160k people that INSERT takes ~11s (4 indexes on segments_memberships)
--    and trips the 8s PostgREST statement_timeout (57014). A function-local
--    `SET LOCAL statement_timeout` does NOT help — the timeout is armed on the
--    top-level RPC statement before the function runs and is not re-armed by a
--    mid-statement SET (verified). Fix: segments_calculate_members_batch inserts
--    one keyset page (ordered by people.id) per call, so each call stays well
--    under 8s; the admin loops it until done. The DELETE of the prior result is
--    a fast single pass (~175ms) done on the first page only.
--
-- 2. TEST USERS. Synthetic send-testing recipients (acquisition_source =
--    'send_testing') must never appear in any audience. Baked into
--    segments_def_to_sql (the shared predicate compiler) so EVERY consumer —
--    preview, count, materialisation, geo aggregate — excludes them. All callers
--    scan `public.people p`, so the added `p.acquisition_source` clause resolves.
-- ============================================================================
SET LOCAL check_function_bodies = off;

-- --- Part 2: shared exclusion via a thin wrapper over the recursive core ------
-- Rename the recursive compiler to _core (group recursion stays within _core);
-- the public segments_def_to_sql wraps it and appends the test-user exclusion
-- exactly once at the top level.
CREATE OR REPLACE FUNCTION public.segments_def_to_sql_core(def jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_match text := COALESCE(def->>'match', 'all');
  v_conn  text := CASE WHEN v_match = 'any' THEN ' OR ' ELSE ' AND ' END;
  v_conds jsonb := def->'conditions';
  v_cond  jsonb;
  v_type  text;
  v_sql   text;
  v_fn    text;
  v_parts text[] := '{}';
BEGIN
  IF v_conds IS NULL OR jsonb_typeof(v_conds) <> 'array' OR jsonb_array_length(v_conds) = 0 THEN
    RETURN 'false';
  END IF;

  FOR v_cond IN SELECT * FROM jsonb_array_elements(v_conds)
  LOOP
    v_type := v_cond->>'type';
    IF v_type = 'group' THEN
      v_sql := public.segments_def_to_sql_core(v_cond);
    ELSIF v_type = 'event' THEN
      v_sql := public.segments_event_to_sql(v_cond);
    ELSIF v_type = 'attribute' THEN
      v_sql := public.segments_attr_to_sql(v_cond);
    ELSE
      -- Registry dispatch for any module-contributed source.
      SELECT predicate_fn INTO v_fn
        FROM public.segments_condition_sources
       WHERE kind = v_type AND enabled = true;
      IF v_fn IS NULL THEN
        v_sql := 'false';
      ELSE
        BEGIN
          EXECUTE format('SELECT %I($1)', v_fn) INTO v_sql USING v_cond;
          v_sql := COALESCE(NULLIF(v_sql, ''), 'false');
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'segments: provider % failed: %', v_fn, SQLERRM;
          v_sql := 'false';
        END;
      END IF;
    END IF;
    v_parts := array_append(v_parts, '(' || v_sql || ')');
  END LOOP;

  RETURN '(' || array_to_string(v_parts, v_conn) || ')';
END;
$$;

-- Public entry point: user predicate AND (not a synthetic send-testing person).
CREATE OR REPLACE FUNCTION public.segments_def_to_sql(def jsonb)
RETURNS text
LANGUAGE sql
AS $$
  SELECT '(' || public.segments_def_to_sql_core(def) || ') AND (p.acquisition_source IS DISTINCT FROM ''send_testing'')';
$$;

COMMENT ON FUNCTION public.segments_def_to_sql(jsonb) IS
  'Compile a segment definition to a WHERE predicate over people p, always excluding synthetic send-testing people (acquisition_source=''send_testing''). Recursion lives in segments_def_to_sql_core.';

-- --- Part 1: keyset-batched materialisation (beats the 8s RPC timeout) --------
CREATE OR REPLACE FUNCTION public.segments_calculate_members_batch(
  p_segment_id uuid,
  p_after      uuid DEFAULT NULL,
  p_limit      int  DEFAULT 25000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_def        jsonb;
  v_type       text;
  v_where      text;
  v_limit      int := GREATEST(1, LEAST(COALESCE(p_limit, 25000), 50000));
  v_page_count int;
  v_last       uuid;
  v_count      int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT definition, type INTO v_def, v_type FROM public.segments WHERE id = p_segment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'segment not found: %', p_segment_id;
  END IF;

  -- Manual segments carry no rule; just report their current size.
  IF v_type = 'manual' THEN
    SELECT count(*) INTO v_count FROM public.segments_memberships WHERE segment_id = p_segment_id;
    RETURN jsonb_build_object('inserted', 0, 'last_person_id', NULL, 'remaining', false, 'count', v_count);
  END IF;

  v_where := public.segments_def_to_sql(v_def);

  -- First page clears the previous calculation (one fast pass).
  IF p_after IS NULL THEN
    DELETE FROM public.segments_memberships
     WHERE segment_id = p_segment_id AND source = 'calculated';
  END IF;

  -- One keyset page ordered by people.id (PK). MATERIALIZED so the page is
  -- computed once and the inserted rows match the returned count/last-id.
  EXECUTE format($q$
    WITH page AS MATERIALIZED (
      SELECT p.id
      FROM public.people p
      WHERE (%s) AND ($1 IS NULL OR p.id > $1)
      ORDER BY p.id
      LIMIT %s
    ), ins AS (
      INSERT INTO public.segments_memberships (segment_id, person_id, source)
      SELECT $2, id, 'calculated' FROM page
      ON CONFLICT (segment_id, person_id) DO NOTHING
    )
    SELECT (SELECT count(*) FROM page)::int, (SELECT id FROM page ORDER BY id DESC LIMIT 1)
  $q$, v_where, v_limit)
  INTO v_page_count, v_last
  USING p_after, p_segment_id;

  v_page_count := COALESCE(v_page_count, 0);

  -- A full page means there may be more people beyond v_last → keep going.
  IF v_page_count = v_limit THEN
    RETURN jsonb_build_object('inserted', v_page_count, 'last_person_id', v_last, 'remaining', true, 'count', NULL);
  END IF;

  -- Final page: record the total + history, mirroring segments_calculate_members.
  SELECT count(*) INTO v_count FROM public.segments_memberships WHERE segment_id = p_segment_id;
  UPDATE public.segments
     SET cached_count = v_count, last_calculated_at = now()
   WHERE id = p_segment_id;
  INSERT INTO public.segments_calculation_history (segment_id, member_count, triggered_by)
    VALUES (p_segment_id, v_count, 'batch');

  RETURN jsonb_build_object('inserted', v_page_count, 'last_person_id', v_last, 'remaining', false, 'count', v_count);
END;
$$;

COMMENT ON FUNCTION public.segments_calculate_members_batch(uuid, uuid, int) IS
  'Materialise one keyset page (people.id > p_after, LIMIT p_limit) of a dynamic segment. First call (p_after NULL) clears the prior calculation. Loop from the client with last_person_id until remaining=false. Bounded per call to stay under the 8s RPC timeout.';
