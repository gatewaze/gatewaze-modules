-- ============================================================================
-- Module: segments
-- Migration: 006_membership_providers
-- Description: Phase A membership condition providers — event_registration,
-- calendar_member, ambassador_application — registered into the condition
-- source registry (005). Each = a predicate fn (EXISTS over the module table,
-- format(%L)-quoted, to_regclass-guarded) + a vocabulary fn + an index +
-- a guarded registry row (only registered when the module's table exists).
--
-- These live in segments (with to_regclass guards) for Phase A; module-owned
-- registration is the Phase B refinement (needs segments as a module dep or a
-- registration hook). check_function_bodies=off so fns referencing a table that
-- a given brand hasn't installed still create (they no-op via to_regclass).
-- ============================================================================
SET LOCAL check_function_bodies = off;

-- ---- event_registration ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_event_registration_to_sql(cond jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := NULLIF(cond->>'event_id','')::uuid;
  v_op text := COALESCE(cond->>'operator','is');
  v_status text := '';
  v_exists text;
BEGIN
  IF v_id IS NULL THEN RETURN 'false'; END IF;
  IF to_regclass('public.events_registrations') IS NULL THEN
    RETURN CASE WHEN v_op='is_not' THEN 'true' ELSE 'false' END;
  END IF;
  IF jsonb_typeof(cond->'statuses')='array' AND jsonb_array_length(cond->'statuses')>0 THEN
    SELECT ' AND r.status IN (' || string_agg(quote_literal(s), ',') || ')'
      INTO v_status FROM jsonb_array_elements_text(cond->'statuses') s;
  END IF;
  v_exists := format('EXISTS (SELECT 1 FROM public.events_registrations r WHERE r.person_id = p.id AND r.event_id = %L%s)', v_id, v_status);
  RETURN CASE WHEN v_op='is_not' THEN 'NOT '||v_exists ELSE v_exists END;
END $$;

CREATE OR REPLACE FUNCTION public.segments_event_registration_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(obj), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', e.event_id,
      'label', e.event_title || COALESCE(' — ' || to_char(e.event_start, 'YYYY-MM-DD'), '')) AS obj
    FROM public.events e
    WHERE (p_search IS NULL OR e.event_title ILIKE '%'||p_search||'%')
    ORDER BY e.event_start DESC NULLS LAST
    LIMIT p_limit
  ) x;
$$;

-- ---- calendar_member -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_calendar_member_to_sql(cond jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := NULLIF(cond->>'calendar_id','')::uuid;
  v_op text := COALESCE(cond->>'operator','is');
  v_status text := NULLIF(cond->>'status','');
  v_clause text := '';
  v_exists text;
BEGIN
  IF v_id IS NULL THEN RETURN 'false'; END IF;
  IF to_regclass('public.calendars_members') IS NULL THEN
    RETURN CASE WHEN v_op='is_not' THEN 'true' ELSE 'false' END;
  END IF;
  IF v_status IS NOT NULL THEN v_clause := format(' AND m.membership_status = %L', v_status); END IF;
  v_exists := format('EXISTS (SELECT 1 FROM public.calendars_members m WHERE m.person_id = p.id AND m.calendar_id = %L%s)', v_id, v_clause);
  RETURN CASE WHEN v_op='is_not' THEN 'NOT '||v_exists ELSE v_exists END;
END $$;

CREATE OR REPLACE FUNCTION public.segments_calendar_member_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(obj), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', c.id, 'label', c.name) AS obj
    FROM public.calendars c
    WHERE (p_search IS NULL OR c.name ILIKE '%'||p_search||'%')
    ORDER BY c.name LIMIT p_limit
  ) x;
$$;

-- ---- ambassador_application ------------------------------------------------
CREATE OR REPLACE FUNCTION public.segments_ambassador_application_to_sql(cond jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := NULLIF(cond->>'program_id','')::uuid;
  v_op text := COALESCE(cond->>'operator','is');
  v_status text := NULLIF(cond->>'status','');
  v_clause text := '';
  v_exists text;
BEGIN
  IF v_id IS NULL THEN RETURN 'false'; END IF;
  IF to_regclass('public.ambassador_applications') IS NULL THEN
    RETURN CASE WHEN v_op='is_not' THEN 'true' ELSE 'false' END;
  END IF;
  IF v_status IS NOT NULL THEN v_clause := format(' AND a.status = %L', v_status); END IF;
  v_exists := format('EXISTS (SELECT 1 FROM public.ambassador_applications a WHERE a.person_id = p.id AND a.program_id = %L%s)', v_id, v_clause);
  RETURN CASE WHEN v_op='is_not' THEN 'NOT '||v_exists ELSE v_exists END;
END $$;

CREATE OR REPLACE FUNCTION public.segments_ambassador_application_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(obj), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', pr.id, 'label', pr.name) AS obj
    FROM public.ambassador_programs pr
    WHERE (p_search IS NULL OR pr.name ILIKE '%'||p_search||'%')
    ORDER BY pr.name LIMIT p_limit
  ) x;
$$;

-- ---- Register the providers (guarded: only when the module's table exists) --
DO $$
BEGIN
  IF to_regclass('public.events_registrations') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_events_reg_person_event ON public.events_registrations (person_id, event_id);
    INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
    VALUES ('event_registration','events','Event registration','segments_event_registration_to_sql','segments_event_registration_vocab',
      jsonb_build_object('type','object','required',jsonb_build_array('event_id'),
        'properties', jsonb_build_object(
          'event_id', jsonb_build_object('type','string','x-entity-source',true),
          'statuses', jsonb_build_object('type','array'))),
      ARRAY['is','is_not'], 20)
    ON CONFLICT (kind) DO UPDATE SET predicate_fn=EXCLUDED.predicate_fn, vocabulary_fn=EXCLUDED.vocabulary_fn, params_schema=EXCLUDED.params_schema, operators=EXCLUDED.operators, label=EXCLUDED.label;
  END IF;

  IF to_regclass('public.calendars_members') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_cal_members_person_cal ON public.calendars_members (person_id, calendar_id);
    INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
    VALUES ('calendar_member','calendars','Calendar membership','segments_calendar_member_to_sql','segments_calendar_member_vocab',
      jsonb_build_object('type','object','required',jsonb_build_array('calendar_id'),
        'properties', jsonb_build_object(
          'calendar_id', jsonb_build_object('type','string','x-entity-source',true),
          'status', jsonb_build_object('type','string'))),
      ARRAY['is','is_not'], 30)
    ON CONFLICT (kind) DO UPDATE SET predicate_fn=EXCLUDED.predicate_fn, vocabulary_fn=EXCLUDED.vocabulary_fn, params_schema=EXCLUDED.params_schema, operators=EXCLUDED.operators, label=EXCLUDED.label;
  END IF;

  IF to_regclass('public.ambassador_applications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_amb_app_person_program ON public.ambassador_applications (person_id, program_id);
    INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
    VALUES ('ambassador_application','ambassadors','Ambassador application','segments_ambassador_application_to_sql','segments_ambassador_application_vocab',
      jsonb_build_object('type','object','required',jsonb_build_array('program_id'),
        'properties', jsonb_build_object(
          'program_id', jsonb_build_object('type','string','x-entity-source',true),
          'status', jsonb_build_object('type','string'))),
      ARRAY['is','is_not'], 40)
    ON CONFLICT (kind) DO UPDATE SET predicate_fn=EXCLUDED.predicate_fn, vocabulary_fn=EXCLUDED.vocabulary_fn, params_schema=EXCLUDED.params_schema, operators=EXCLUDED.operators, label=EXCLUDED.label;
  END IF;
END $$;
