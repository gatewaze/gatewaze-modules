-- ============================================================================
-- Module: segments
-- Migration: 003_event_filters
-- Description: Let event conditions filter on the event's own properties
-- (e.g. "attended an event in San Francisco") by translating an `event_filters`
-- array into predicates on people_events.event_data (JSONB). Previously the
-- engine matched only event_name + count + time window; the TypeScript
-- `property_filters` field was accepted but IGNORED by the SQL. This wires it
-- through (accepting both `event_filters` and the legacy `property_filters` key).
--
-- Prerequisite (spec-campaigns-module.md Phase 3): the pipeline writing
-- `event_attended` / `event_registered` rows into people_events must populate
-- the filtered keys (e.g. event_city, event_id, event_name) in event_data, with
-- a one-time backfill of historical rows. Until that lands, filters on absent
-- keys simply match nobody (the JSONB ->> returns NULL).
--
-- Self-contained: keeps the people_events-centric engine (no cross-table join).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_event_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_name    text := cond->>'event_type';
  v_op      text := cond->>'operator';
  v_count   int  := GREATEST(COALESCE(NULLIF(cond->>'value', '')::int, 1), 0);
  v_tw      jsonb := cond->'time_window';
  v_filters jsonb := COALESCE(cond->'event_filters', cond->'property_filters');
  v_where   text;
  v_time    text := '';
  v_filt    text := '';
  v_f       jsonb;
  v_prop    text;
  v_fop     text;
  v_val     text;
  v_col     text;
BEGIN
  IF v_name IS NULL OR v_name = '' THEN
    RETURN 'true';
  END IF;

  -- The behavioural event stream may not exist in every environment. Degrade
  -- gracefully: "has not performed" is vacuously true, everything else matches
  -- nobody.
  IF to_regclass('public.people_events') IS NULL THEN
    RETURN CASE WHEN v_op = 'not_performed' THEN 'true' ELSE 'false' END;
  END IF;

  v_where := format('e.person_id = p.id AND e.event_name = %L', v_name);

  -- Time window (relative / absolute) — unchanged from migration 002.
  IF v_tw IS NOT NULL AND COALESCE(v_tw->>'type', 'relative') = 'relative' THEN
    v_time := format(
      ' AND e.occurred_at >= now() - ((%L || '' '' || %L)::interval)',
      COALESCE(NULLIF(v_tw->>'relative_value', '')::int, 30)::text,
      COALESCE(NULLIF(v_tw->>'relative_unit', ''), 'days')
    );
  ELSIF v_tw IS NOT NULL AND v_tw->>'type' = 'absolute' THEN
    IF v_tw ? 'start_date' THEN
      v_time := v_time || format(' AND e.occurred_at >= %L', v_tw->>'start_date');
    END IF;
    IF v_tw ? 'end_date' THEN
      v_time := v_time || format(' AND e.occurred_at <= %L', v_tw->>'end_date');
    END IF;
  END IF;

  -- NEW: event_filters → predicates on event_data JSONB.
  IF v_filters IS NOT NULL AND jsonb_typeof(v_filters) = 'array' THEN
    FOR v_f IN SELECT * FROM jsonb_array_elements(v_filters)
    LOOP
      v_prop := v_f->>'property';
      v_fop  := COALESCE(v_f->>'operator', 'equals');
      v_val  := v_f->>'value';
      CONTINUE WHEN v_prop IS NULL OR v_prop = '';
      v_col := format('(e.event_data->>%L)', v_prop);
      v_filt := v_filt || CASE v_fop
        WHEN 'equals'       THEN format(' AND %s = %L', v_col, COALESCE(v_val, ''))
        WHEN 'not_equals'   THEN format(' AND %s IS DISTINCT FROM %L', v_col, COALESCE(v_val, ''))
        WHEN 'contains'     THEN format(' AND %s ILIKE %L', v_col, '%' || COALESCE(v_val, '') || '%')
        WHEN 'not_contains' THEN format(' AND (%s IS NULL OR %s NOT ILIKE %L)', v_col, v_col, '%' || COALESCE(v_val, '') || '%')
        WHEN 'starts_with'  THEN format(' AND %s ILIKE %L', v_col, COALESCE(v_val, '') || '%')
        WHEN 'is_set'       THEN format(' AND %s IS NOT NULL AND %s <> ''''', v_col, v_col)
        WHEN 'is_not_set'   THEN format(' AND (%s IS NULL OR %s = '''')', v_col, v_col)
        WHEN 'in_list'      THEN format(' AND %s = ANY (string_to_array(%L, '',''))', v_col, COALESCE(v_val, ''))
        WHEN 'not_in_list'  THEN format(' AND (%s IS NULL OR NOT (%s = ANY (string_to_array(%L, '','')))) ', v_col, v_col, COALESCE(v_val, ''))
        ELSE ''
      END;
    END LOOP;
  END IF;

  v_where := v_where || v_filt;

  CASE v_op
    WHEN 'performed' THEN
      RETURN format('EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'not_performed' THEN
      RETURN format('NOT EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'performed_at_least' THEN
      RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) >= %s', v_where, v_time, v_count);
    WHEN 'performed_at_most' THEN
      RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) <= %s', v_where, v_time, v_count);
    WHEN 'performed_count' THEN
      RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) = %s', v_where, v_time, v_count);
    ELSE
      RETURN 'true';
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.segments_event_to_sql(jsonb) IS
  'Translate an event condition to SQL against people_events: event_name + count + time window + event_filters (predicates on event_data JSONB, e.g. event_city=San Francisco). Accepts event_filters or legacy property_filters.';
