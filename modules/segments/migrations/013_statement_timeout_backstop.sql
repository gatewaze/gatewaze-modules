-- ============================================================================
-- Module: segments
-- Migration: 013_statement_timeout_backstop
-- Description: segments_preview / segments_calculate_members run one bounded,
-- set-based query over public.people (count+sample, or an INSERT..SELECT of the
-- matching ids). On a large base (~160k people) that legitimately takes longer
-- than PostgREST's short per-request statement_timeout, so saving a broad
-- audience failed with 57014 "canceling statement due to statement timeout".
--
-- Fix: lift the per-request timeout to a generous CAP (not 0) inside these
-- SECURITY DEFINER functions. The work is bounded (a single pass / one insert of
-- at most |people| rows), so it completes in seconds; the cap only backstops a
-- pathological predicate. This is deliberately a CAP, not an unbounded 0.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_preview(p_definition jsonb, p_limit int DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_where  text;
  v_count  bigint;
  v_sample jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SET LOCAL statement_timeout = '120s';   -- backstop; preview is count+sample, fast

  v_where := public.segments_def_to_sql(p_definition);

  EXECUTE format('SELECT count(*) FROM public.people p WHERE %s', v_where)
    INTO v_count;

  EXECUTE format($q$
    SELECT COALESCE(jsonb_agg(row), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'cio_id', p.cio_id,
        'email', p.email,
        'attributes', p.attributes,
        'created_at', p.created_at
      ) AS row
      FROM public.people p
      WHERE %s
      ORDER BY p.created_at DESC
      LIMIT %s
    ) sub
  $q$, v_where, GREATEST(p_limit, 0))
    INTO v_sample;

  RETURN jsonb_build_object(
    'count', v_count,
    'sample', v_sample,
    'is_estimate', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.segments_calculate_members(p_segment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_def   jsonb;
  v_type  text;
  v_where text;
  v_count int;
  v_start timestamptz := clock_timestamp();
  v_dur   int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  -- Backstop: the INSERT..SELECT below is one bounded pass over people. Lift the
  -- short per-request timeout so a large-but-valid audience can materialize.
  SET LOCAL statement_timeout = '300s';

  SELECT definition, type INTO v_def, v_type
  FROM public.segments WHERE id = p_segment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'segment not found: %', p_segment_id;
  END IF;

  IF v_type = 'manual' THEN
    SELECT count(*) INTO v_count
    FROM public.segments_memberships WHERE segment_id = p_segment_id;
  ELSE
    v_where := public.segments_def_to_sql(v_def);

    DELETE FROM public.segments_memberships
    WHERE segment_id = p_segment_id AND source = 'calculated';

    EXECUTE format($q$
      INSERT INTO public.segments_memberships (segment_id, person_id, source)
      SELECT %L, p.id, 'calculated'
      FROM public.people p
      WHERE %s
      ON CONFLICT (segment_id, person_id) DO NOTHING
    $q$, p_segment_id, v_where);

    SELECT count(*) INTO v_count
    FROM public.segments_memberships WHERE segment_id = p_segment_id;
  END IF;

  v_dur := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::int;

  UPDATE public.segments
     SET cached_count = v_count,
         last_calculated_at = now(),
         calculation_duration_ms = v_dur
   WHERE id = p_segment_id;

  INSERT INTO public.segments_calculation_history
    (segment_id, member_count, calculation_duration_ms, triggered_by)
  VALUES (p_segment_id, v_count, v_dur, 'manual');

  RETURN jsonb_build_object('count', v_count, 'duration_ms', v_dur);
END;
$$;
