-- ============================================================================
-- Module: segments
-- Migration: 007_event_source_tables
-- Description: Resolve event_registered / event_attended conditions against the
-- authoritative events tables (events_registrations / events_attendance joined
-- to events), so event_filters like { property: 'event_city', value: 'San
-- Francisco' } work even on brands that don't populate the behavioural
-- people_events stream. Migration 003 wired event_filters against
-- people_events.event_data; here we map the same filters onto real events
-- columns (event_city, event_country_code, event_title, event_id, status) and
-- fall back to the people_events path for any other event type (or when the
-- events tables aren't installed).
-- ============================================================================
SET LOCAL check_function_bodies = off;

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
  v_src     text := NULL;      -- authoritative source table (events path)
  v_time_col text := 'r.created_at';
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

  -- Prefer the authoritative events tables for the two event-module events.
  IF v_name = 'event_registered' AND to_regclass('public.events_registrations') IS NOT NULL THEN
    v_src := 'public.events_registrations'; v_time_col := 'r.created_at';
  ELSIF v_name = 'event_attended' AND to_regclass('public.events_attendance') IS NOT NULL THEN
    v_src := 'public.events_attendance'; v_time_col := 'r.created_at';
  END IF;

  -- ---- Authoritative events-table path (with events join for filters) -------
  IF v_src IS NOT NULL THEN
    v_where := 'r.person_id = p.id';

    IF v_tw IS NOT NULL AND COALESCE(v_tw->>'type', 'relative') = 'relative' THEN
      v_time := format(' AND %s >= now() - ((%L || '' '' || %L)::interval)', v_time_col,
        COALESCE(NULLIF(v_tw->>'relative_value', '')::int, 30)::text,
        COALESCE(NULLIF(v_tw->>'relative_unit', ''), 'days'));
    ELSIF v_tw IS NOT NULL AND v_tw->>'type' = 'absolute' THEN
      IF v_tw ? 'start_date' THEN v_time := v_time || format(' AND %s >= %L', v_time_col, v_tw->>'start_date'); END IF;
      IF v_tw ? 'end_date'   THEN v_time := v_time || format(' AND %s <= %L', v_time_col, v_tw->>'end_date'); END IF;
    END IF;

    IF v_filters IS NOT NULL AND jsonb_typeof(v_filters) = 'array' THEN
      FOR v_f IN SELECT * FROM jsonb_array_elements(v_filters)
      LOOP
        v_prop := v_f->>'property';
        v_fop  := COALESCE(v_f->>'operator', 'equals');
        v_val  := v_f->>'value';
        CONTINUE WHEN v_prop IS NULL OR v_prop = '';
        v_col := CASE v_prop
          WHEN 'event_city'         THEN 'ev.event_city'
          WHEN 'event_country_code' THEN 'ev.event_country_code'
          WHEN 'event_country'      THEN 'ev.event_country_code'
          WHEN 'event_title'        THEN 'ev.event_title'
          WHEN 'event_name'         THEN 'ev.event_title'
          WHEN 'event_id'           THEN 'ev.event_id'
          WHEN 'status'             THEN 'r.status'
          ELSE NULL
        END;
        CONTINUE WHEN v_col IS NULL;   -- unknown property: ignore (don't constrain)
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

    v_where := v_where || v_filt || v_time;
    -- Only JOIN events when a filter needs it (keeps the simple case cheap).
    DECLARE v_from text := v_src || ' r' || CASE WHEN v_filt <> '' AND position('ev.' in v_filt) > 0 THEN ' JOIN public.events ev ON ev.id = r.event_id' ELSE '' END;
    BEGIN
      CASE v_op
        WHEN 'performed'          THEN RETURN format('EXISTS (SELECT 1 FROM %s WHERE %s)', v_from, v_where);
        WHEN 'not_performed'      THEN RETURN format('NOT EXISTS (SELECT 1 FROM %s WHERE %s)', v_from, v_where);
        WHEN 'performed_at_least' THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) >= %s', v_from, v_where, v_count);
        WHEN 'performed_at_most'  THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) <= %s', v_from, v_where, v_count);
        WHEN 'performed_count'    THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) = %s', v_from, v_where, v_count);
        ELSE RETURN 'true';
      END CASE;
    END;
  END IF;

  -- ---- Fallback: behavioural people_events stream (migration 003 path) ------
  IF to_regclass('public.people_events') IS NULL THEN
    RETURN CASE WHEN v_op = 'not_performed' THEN 'true' ELSE 'false' END;
  END IF;

  v_where := format('e.person_id = p.id AND e.event_name = %L', v_name);
  IF v_tw IS NOT NULL AND COALESCE(v_tw->>'type', 'relative') = 'relative' THEN
    v_time := format(' AND e.occurred_at >= now() - ((%L || '' '' || %L)::interval)',
      COALESCE(NULLIF(v_tw->>'relative_value', '')::int, 30)::text,
      COALESCE(NULLIF(v_tw->>'relative_unit', ''), 'days'));
  ELSIF v_tw IS NOT NULL AND v_tw->>'type' = 'absolute' THEN
    IF v_tw ? 'start_date' THEN v_time := v_time || format(' AND e.occurred_at >= %L', v_tw->>'start_date'); END IF;
    IF v_tw ? 'end_date'   THEN v_time := v_time || format(' AND e.occurred_at <= %L', v_tw->>'end_date'); END IF;
  END IF;
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
    WHEN 'performed'          THEN RETURN format('EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'not_performed'      THEN RETURN format('NOT EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'performed_at_least' THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) >= %s', v_where, v_time, v_count);
    WHEN 'performed_at_most'  THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) <= %s', v_where, v_time, v_count);
    WHEN 'performed_count'    THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) = %s', v_where, v_time, v_count);
    ELSE RETURN 'true';
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.segments_event_to_sql(jsonb) IS
  'Translate an event condition to SQL. event_registered/event_attended resolve against events_registrations/events_attendance JOIN events (event_filters map to event_city/event_country_code/event_title/event_id/status); other event types use the people_events behavioural stream (event_data filters).';
