-- ============================================================================
-- Module: segments
-- Migration: 002_segments_functions
-- Description: Membership-calculation engine. Translates a segment's JSONB
--              definition into SQL predicates against public.people (attribute
--              conditions) and public.people_events (event conditions), and
--              exposes the RPCs the admin UI calls: preview, calculate, count,
--              members, and the distinct event-name list.
--
-- All callable RPCs are SECURITY DEFINER + is_admin()-gated, mirroring the
-- admin-only write policies in 001_segments_tables.sql. The internal _to_sql
-- helpers run inside the definer context and are not meant to be called
-- directly by clients.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Resolve a definition "field" to a people-row SQL expression (alias `p`).
--   email                 -> p.email
--   attributes.<key>      -> (p.attributes ->> '<key>')
--   <key>                 -> (p.attributes ->> '<key>')   (custom fallback)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_attr_column(p_field text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_field = 'email' THEN
    RETURN 'p.email';
  ELSIF p_field LIKE 'attributes.%' THEN
    RETURN format('(p.attributes ->> %L)', substring(p_field FROM 12));
  ELSE
    RETURN format('(p.attributes ->> %L)', p_field);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Attribute condition -> boolean SQL expression (over alias `p`).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_attr_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_field text := cond->>'field';
  v_op    text := cond->>'operator';
  v_col   text;
  v_val   jsonb := cond->'value';
  v_text  text := cond->>'value';
  v_arr   text;
  v_num   constant text := '^-?[0-9]+(\.[0-9]+)?$';
BEGIN
  IF v_field IS NULL OR v_field = '' THEN
    RETURN 'true';
  END IF;
  v_col := public.segments_attr_column(v_field);

  CASE v_op
    WHEN 'equals' THEN
      RETURN format('%s = %L', v_col, v_text);
    WHEN 'not_equals' THEN
      RETURN format('%s IS DISTINCT FROM %L', v_col, v_text);
    WHEN 'contains' THEN
      RETURN format('%s ILIKE %L', v_col, '%' || v_text || '%');
    WHEN 'not_contains' THEN
      RETURN format('(%s IS NULL OR %s NOT ILIKE %L)', v_col, v_col, '%' || v_text || '%');
    WHEN 'starts_with' THEN
      RETURN format('%s ILIKE %L', v_col, v_text || '%');
    WHEN 'ends_with' THEN
      RETURN format('%s ILIKE %L', v_col, '%' || v_text);
    WHEN 'is_set' THEN
      RETURN format('(%s IS NOT NULL AND %s <> '''')', v_col, v_col);
    WHEN 'is_not_set' THEN
      RETURN format('(%s IS NULL OR %s = '''')', v_col, v_col);
    WHEN 'greater_than' THEN
      RETURN format('(%s ~ %L AND %s::numeric > %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'less_than' THEN
      RETURN format('(%s ~ %L AND %s::numeric < %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'greater_than_or_equal' THEN
      RETURN format('(%s ~ %L AND %s::numeric >= %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'less_than_or_equal' THEN
      RETURN format('(%s ~ %L AND %s::numeric <= %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'matches_regex' THEN
      RETURN format('%s ~ %L', v_col, v_text);
    WHEN 'in_list' THEN
      IF jsonb_typeof(v_val) = 'array' THEN
        SELECT string_agg(format('%L', elem), ',') INTO v_arr
        FROM jsonb_array_elements_text(v_val) elem;
      ELSE
        SELECT string_agg(format('%L', trim(elem)), ',') INTO v_arr
        FROM unnest(string_to_array(COALESCE(v_text, ''), ',')) elem
        WHERE trim(elem) <> '';
      END IF;
      IF v_arr IS NULL THEN RETURN 'false'; END IF;
      RETURN format('%s IN (%s)', v_col, v_arr);
    WHEN 'not_in_list' THEN
      IF jsonb_typeof(v_val) = 'array' THEN
        SELECT string_agg(format('%L', elem), ',') INTO v_arr
        FROM jsonb_array_elements_text(v_val) elem;
      ELSE
        SELECT string_agg(format('%L', trim(elem)), ',') INTO v_arr
        FROM unnest(string_to_array(COALESCE(v_text, ''), ',')) elem
        WHERE trim(elem) <> '';
      END IF;
      IF v_arr IS NULL THEN RETURN 'true'; END IF;
      RETURN format('(%s IS NULL OR %s NOT IN (%s))', v_col, v_col, v_arr);
    ELSE
      RETURN 'true';
  END CASE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Event condition -> boolean SQL expression (EXISTS/count over people_events,
-- correlated on the outer alias `p`). The event name is stored in event_type.
-- The count value is cast to int so it can never be injected unquoted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_event_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_name  text := cond->>'event_type';
  v_op    text := cond->>'operator';
  v_count int  := GREATEST(COALESCE(NULLIF(cond->>'value', '')::int, 1), 0);
  v_tw    jsonb := cond->'time_window';
  v_where text;
  v_time  text := '';
BEGIN
  IF v_name IS NULL OR v_name = '' THEN
    RETURN 'true';
  END IF;

  -- The behavioural event stream (core migration 00038_people_events) may not
  -- exist yet in every environment. Degrade gracefully instead of emitting SQL
  -- that references a missing relation: "has not performed" is vacuously true,
  -- every other operator matches nobody.
  IF to_regclass('public.people_events') IS NULL THEN
    RETURN CASE WHEN v_op = 'not_performed' THEN 'true' ELSE 'false' END;
  END IF;

  v_where := format('e.person_id = p.id AND e.event_name = %L', v_name);

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

-- ---------------------------------------------------------------------------
-- Definition / group -> combined boolean SQL expression (recursive).
-- Empty / malformed -> 'false' (never select everyone by accident).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_def_to_sql(def jsonb)
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
  v_parts text[] := '{}';
BEGIN
  IF v_conds IS NULL
     OR jsonb_typeof(v_conds) <> 'array'
     OR jsonb_array_length(v_conds) = 0 THEN
    RETURN 'false';
  END IF;

  FOR v_cond IN SELECT * FROM jsonb_array_elements(v_conds)
  LOOP
    v_type := v_cond->>'type';
    IF v_type = 'group' THEN
      v_sql := public.segments_def_to_sql(v_cond);
    ELSIF v_type = 'event' THEN
      v_sql := public.segments_event_to_sql(v_cond);
    ELSE
      v_sql := public.segments_attr_to_sql(v_cond);
    END IF;
    v_parts := array_append(v_parts, '(' || v_sql || ')');
  END LOOP;

  RETURN '(' || array_to_string(v_parts, v_conn) || ')';
END;
$$;

-- ---------------------------------------------------------------------------
-- Preview: count + sample of matching people, no persistence.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Calculate + persist membership for a segment. Preserves manual members,
-- replaces the 'calculated' set for dynamic/static segments.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Member count (cached column, or live count of the memberships table).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_get_member_count(
  p_segment_id uuid,
  p_use_cache  boolean DEFAULT true
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_use_cache THEN
    SELECT cached_count INTO v_count FROM public.segments WHERE id = p_segment_id;
  ELSE
    SELECT count(*) INTO v_count
    FROM public.segments_memberships WHERE segment_id = p_segment_id;
  END IF;

  RETURN COALESCE(v_count, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- Paginated members of a segment, with optional name/email search.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_get_members_paginated(
  p_segment_id uuid,
  p_offset     int DEFAULT 0,
  p_limit      int DEFAULT 50,
  p_search     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total   int;
  v_members jsonb;
  v_search  text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_like    text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_like := '%' || COALESCE(v_search, '') || '%';

  SELECT count(*) INTO v_total
  FROM public.segments_memberships m
  JOIN public.people p ON p.id = m.person_id
  WHERE m.segment_id = p_segment_id
    AND (
      v_search IS NULL
      OR p.email ILIKE v_like
      OR (p.attributes->>'first_name') ILIKE v_like
      OR (p.attributes->>'last_name')  ILIKE v_like
      OR (p.attributes->>'company')    ILIKE v_like
    );

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'email')), '[]'::jsonb)
    INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'id', p.id,
      'cio_id', p.cio_id,
      'email', p.email,
      'attributes', p.attributes,
      'created_at', p.created_at
    ) AS row
    FROM public.segments_memberships m
    JOIN public.people p ON p.id = m.person_id
    WHERE m.segment_id = p_segment_id
      AND (
        v_search IS NULL
        OR p.email ILIKE v_like
        OR (p.attributes->>'first_name') ILIKE v_like
        OR (p.attributes->>'last_name')  ILIKE v_like
        OR (p.attributes->>'company')    ILIKE v_like
      )
    ORDER BY p.email
    OFFSET GREATEST(p_offset, 0)
    LIMIT GREATEST(p_limit, 0)
  ) sub;

  RETURN jsonb_build_object('members', v_members, 'total', v_total);
END;
$$;

-- ---------------------------------------------------------------------------
-- Distinct event names seen in people_events (for the Person Event picker).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_event_names()
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_names text[];
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF to_regclass('public.people_events') IS NULL THEN
    RETURN '{}';
  END IF;

  EXECUTE $q$
    SELECT COALESCE(array_agg(DISTINCT event_name ORDER BY event_name), '{}')
    FROM public.people_events
    WHERE event_name IS NOT NULL AND event_name <> ''
  $q$ INTO v_names;

  RETURN v_names;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants — only the client-facing RPCs are exposed to authenticated users
-- (each re-checks is_admin() internally).
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.segments_preview(jsonb, int)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.segments_calculate_members(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.segments_get_member_count(uuid, boolean)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.segments_get_members_paginated(uuid, int, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.segments_event_names()                             TO authenticated;
