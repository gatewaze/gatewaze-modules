-- ============================================================================
-- Module: segments
-- Migration: 024_service_role_recalc
-- Description: Let the service role recalculate a segment.
--
-- The broadcasts dispatcher recalculates a send's segment just before fan-out,
-- so conditions such as "not registered for this event" or "has not replied"
-- reflect the moment of sending. It runs as the service role, where
-- auth.uid() is null, so is_admin() was false and every recalc raised
-- 'forbidden'. The dispatcher logged a warning and sent to the membership as
-- last calculated in the admin, which could be days old.
--
-- Same idea as segments_preview_service's guard (012), made NULL-safe. Body
-- otherwise unchanged from 013; history rows record 'service' or 'manual'.
-- ============================================================================

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
  -- COALESCE: with no JWT claims auth.role() is NULL, and NOT (NULL OR false)
  -- is NULL, which IF treats as false — the guard would not raise.
  v_service boolean := COALESCE(auth.role() = 'service_role', false);
BEGIN
  IF NOT (v_service OR public.is_admin()) THEN
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
  VALUES (p_segment_id, v_count, v_dur, CASE WHEN v_service THEN 'service' ELSE 'manual' END);

  RETURN jsonb_build_object('count', v_count, 'duration_ms', v_dur);
END;
$$;
