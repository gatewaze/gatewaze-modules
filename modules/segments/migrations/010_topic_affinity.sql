-- ============================================================================
-- Module: segments
-- Migration: 010_topic_affinity
-- Spec: spec-plays-audience-intelligence.md §4.7 (topic-affinity targeting)
-- Description: A `topic_affinity` condition source — "people interested in
--   <topics> (≥ affinity)". Reads the governed, source-weighted + decayed
--   person_topic_interests view (signals module), so the audience honours which
--   knowledge sources are enabled + lawful basis automatically. Registering it
--   here lets ANY segment (and every downstream broadcast) target by interest
--   through the proven segment → recipients → drip path — no bespoke plumbing.
--
--   first_party_only restricts to people with first-party/self-declared evidence
--   for the topic (compliance-sensitive sends). Missing topics → matches nobody
--   (never target everyone by accident).
--
--   Guarded: if the person_topic_interests view is absent (signals not
--   installed) the predicate degrades to 'false' rather than erroring, so a
--   brand without signals still creates + runs segments.
--   Idempotent.
-- ============================================================================
SET LOCAL check_function_bodies = off;

-- Predicate: person has affinity to ANY of cond.topics at/above min_affinity.
CREATE OR REPLACE FUNCTION public.segments_topic_affinity_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_topics text[];
  v_min    float8  := COALESCE(NULLIF(cond->>'min_affinity', '')::float8, 0.5);
  v_op     text    := COALESCE(cond->>'operator', 'interested_in');
  v_first  boolean := COALESCE((cond->>'first_party_only')::boolean, false);
  v_has_view boolean;
  v_list   text;
  v_pred   text;
BEGIN
  -- Degrade gracefully when the signals topic graph is not installed.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'person_topic_interests'
  ) INTO v_has_view;
  IF NOT v_has_view THEN
    RETURN CASE WHEN v_op = 'not_interested_in' THEN 'true' ELSE 'false' END;
  END IF;

  SELECT array_agg(value) INTO v_topics
  FROM jsonb_array_elements_text(COALESCE(cond->'topics', '[]'::jsonb)) AS value;

  IF v_topics IS NULL OR array_length(v_topics, 1) IS NULL THEN
    RETURN CASE WHEN v_op = 'not_interested_in' THEN 'true' ELSE 'false' END;
  END IF;

  v_list := (SELECT string_agg(quote_literal(t), ',') FROM unnest(v_topics) AS t);
  v_pred := format(
    'EXISTS (SELECT 1 FROM public.person_topic_interests pti WHERE pti.person_id = p.id AND pti.topic IN (%s) AND pti.weight >= %s%s)',
    v_list, v_min,
    CASE WHEN v_first THEN ' AND pti.has_first_party' ELSE '' END);

  RETURN CASE WHEN v_op = 'not_interested_in' THEN 'NOT ' || v_pred ELSE v_pred END;
END $$;

-- Vocabulary: topics available for the builder's autocomplete (most-common
-- first). Prefers the curated topic_vocabulary; falls back to distinct topics
-- observed in the graph. Guarded for the no-signals case.
CREATE OR REPLACE FUNCTION public.segments_topic_vocabulary(p_search text, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search text := '%' || COALESCE(NULLIF(trim(p_search), ''), '') || '%';
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_rows   jsonb;
BEGIN
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('value', topic, 'label', topic, 'n', n) ORDER BY n DESC), '[]'::jsonb)
      INTO v_rows
    FROM (
      SELECT pti.topic, count(distinct pti.person_id) AS n
      FROM public.person_topic_interests pti
      WHERE pti.topic ILIKE v_search
      GROUP BY pti.topic
      ORDER BY n DESC
      LIMIT v_limit
    ) t;
  EXCEPTION WHEN others THEN
    v_rows := '[]'::jsonb;
  END;
  RETURN COALESCE(v_rows, '[]'::jsonb);
END $$;
GRANT EXECUTE ON FUNCTION public.segments_topic_vocabulary(text, int) TO authenticated, service_role;

-- Register in the condition-source registry so the segment builder catalogue +
-- the AI copilot discover it.
INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES ('topic_affinity', 'segments', 'Topic interest', 'segments_topic_affinity_to_sql', 'segments_topic_vocabulary',
  jsonb_build_object('type', 'object', 'required', jsonb_build_array('topics'),
    'properties', jsonb_build_object(
      'topics', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
      'min_affinity', jsonb_build_object('type', 'number'),
      'first_party_only', jsonb_build_object('type', 'boolean'))),
  ARRAY['interested_in', 'not_interested_in'], 15)
ON CONFLICT (kind) DO UPDATE SET predicate_fn = EXCLUDED.predicate_fn, vocabulary_fn = EXCLUDED.vocabulary_fn, params_schema = EXCLUDED.params_schema, operators = EXCLUDED.operators, label = EXCLUDED.label;
