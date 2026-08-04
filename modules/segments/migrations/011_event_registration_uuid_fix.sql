-- ============================================================================
-- Module: segments
-- Migration: 011_event_registration_uuid_fix
-- Description: Fix the event_registration condition source. The vocabulary fn
-- handed the audience picker events.event_id (the external SHORT CODE, e.g.
-- 'c9wc6r') as the entity id, but the predicate fn casts event_id to uuid and
-- matches events_registrations.event_id (the UUID FK -> events.id). So the
-- picker stored a short code, the predicate did 'c9wc6r'::uuid, threw, and the
-- registry dispatcher (005) swallowed the failure to 'false' — silently
-- collapsing the whole audience to 0 people (e.g. broadcast "MCP Jam First
-- Blast" showed 0 instead of ~159k minus the 92 registered).
--
-- Fixes:
--   1. Vocabulary fn returns e.id (the UUID) as the entity id — new picks store
--      the correct identifier.
--   2. Predicate fn resolves event_id tolerantly: a UUID is used directly; a
--      non-UUID is resolved as an events.event_id short code -> events.id. This
--      keeps any already-saved short-code segments working and stops a bad value
--      from throwing (which the registry would hide as an empty audience).
--   3. Data repair: rewrite any stored event_registration condition whose
--      event_id is a short code to the resolved UUID, so the builder shows the
--      selected event and membership recomputes correctly.
-- ============================================================================

-- 1. Predicate: resolve UUID or short code; never throw on a bad id. -----------
CREATE OR REPLACE FUNCTION public.segments_event_registration_to_sql(cond jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_raw    text := NULLIF(cond->>'event_id','');
  v_id     uuid;
  v_op     text := COALESCE(cond->>'operator','is');
  v_status text := '';
  v_exists text;
BEGIN
  IF v_raw IS NULL THEN RETURN 'false'; END IF;
  -- Accept the event UUID (events.id = events_registrations.event_id) directly;
  -- otherwise treat the value as an events.event_id short code and resolve it.
  BEGIN
    v_id := v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_id := NULL;
  END;
  IF v_id IS NULL AND to_regclass('public.events') IS NOT NULL THEN
    SELECT e.id INTO v_id FROM public.events e WHERE e.event_id = v_raw LIMIT 1;
  END IF;
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

-- 2. Vocabulary: return the event UUID (e.id), not the short code (e.event_id). -
CREATE OR REPLACE FUNCTION public.segments_event_registration_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(obj), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', e.id,
      'label', e.event_title || COALESCE(' — ' || to_char(e.event_start, 'YYYY-MM-DD'), '')) AS obj
    FROM public.events e
    WHERE (p_search IS NULL OR e.event_title ILIKE '%'||p_search||'%')
    ORDER BY e.event_start DESC NULLS LAST
    LIMIT p_limit
  ) x;
$$;

-- 3. Repair stored segments that captured the short code instead of the UUID. --
UPDATE public.segments s
SET definition = jsonb_set(
      s.definition, '{conditions}',
      (SELECT jsonb_agg(
         CASE
           WHEN c->>'type' = 'event_registration'
            AND NULLIF(c->>'event_id','') IS NOT NULL
            AND c->>'event_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND ev.id IS NOT NULL
           THEN jsonb_set(c, '{event_id}', to_jsonb(ev.id::text))
           ELSE c
         END
         ORDER BY ord)
       FROM jsonb_array_elements(s.definition->'conditions') WITH ORDINALITY AS t(c, ord)
       LEFT JOIN public.events ev ON ev.event_id = t.c->>'event_id')
    )
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(s.definition->'conditions') c
  WHERE c->>'type' = 'event_registration'
    AND NULLIF(c->>'event_id','') IS NOT NULL
    AND c->>'event_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);
