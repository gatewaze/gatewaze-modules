-- ============================================================================
-- Module: segments
-- Migration: 005_condition_source_registry
-- Description: Generalise cross-module targeting into a CONDITION-PROVIDER
-- REGISTRY (spec-segments-cross-module-targeting.md). A module declares a
-- targetable "source" (predicate fn + vocabulary fn + params schema/operators);
-- segments_def_to_sql dispatches dynamically; the copilot/builder read one
-- catalogue. Migrates the 004 'subscription' one-off onto the registry.
-- ============================================================================

-- 1. The registry -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.segments_condition_sources (
  kind          text PRIMARY KEY,
  module_id     text NOT NULL,
  label         text NOT NULL,
  predicate_fn  text NOT NULL,                 -- fn(cond jsonb) RETURNS text (predicate over alias p)
  vocabulary_fn text,                          -- fn(p_search text, p_limit int) RETURNS jsonb
  params_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  operators     text[] NOT NULL DEFAULT '{}',
  enabled       boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.segments_condition_sources ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='segments_condition_sources' AND policyname='auth_read_condition_sources') THEN
    CREATE POLICY "auth_read_condition_sources" ON public.segments_condition_sources FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- 2. Dynamic dispatch: route non-core condition types via the registry -------
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
      v_sql := public.segments_def_to_sql(v_cond);
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

-- 3. Catalogue RPC: enabled sources + resolved vocabulary in one round-trip --
CREATE OR REPLACE FUNCTION public.segments_sources_catalog(p_search text DEFAULT NULL, p_entity_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src    record;
  v_ents   jsonb;
  v_err    text;
  v_trunc  boolean;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  FOR v_src IN
    SELECT * FROM public.segments_condition_sources WHERE enabled = true ORDER BY sort_order, label
  LOOP
    v_ents := '[]'::jsonb; v_err := NULL; v_trunc := false;
    IF v_src.vocabulary_fn IS NOT NULL THEN
      BEGIN
        EXECUTE format('SELECT %I($1,$2)', v_src.vocabulary_fn) INTO v_ents USING p_search, p_entity_limit;
        v_ents := COALESCE(v_ents, '[]'::jsonb);
        v_trunc := jsonb_array_length(v_ents) >= p_entity_limit;
      EXCEPTION WHEN OTHERS THEN
        v_ents := '[]'::jsonb; v_err := SQLERRM;
      END;
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', v_src.kind,
      'label', v_src.label,
      'params_schema', v_src.params_schema,
      'operators', to_jsonb(v_src.operators),
      'entities', v_ents,
      'entities_truncated', v_trunc,
      'error', v_err
    ));
  END LOOP;
  RETURN jsonb_build_object('sources', v_out);
END;
$$;

COMMENT ON FUNCTION public.segments_sources_catalog(text, int) IS
  'Enabled condition sources with params_schema, operators, and resolved vocabulary (per-source vocabulary_fn(search,limit)). Admin-only. Powers the copilot + builder.';

-- 4. Subscription vocabulary fn (newsletters resolve list live; + lists) -----
CREATE OR REPLACE FUNCTION public.segments_subscription_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH nl AS (
    SELECT jsonb_build_object('id', c.id, 'label', c.name || ' (newsletter)', 'extra', jsonb_build_object('source','newsletter')) AS e
    FROM public.newsletters_template_collections c
    WHERE c.list_id IS NOT NULL AND (p_search IS NULL OR c.name ILIKE '%'||p_search||'%')
    ORDER BY c.name LIMIT p_limit
  ), ls AS (
    SELECT jsonb_build_object('id', l.id, 'label', l.name || ' (list)', 'extra', jsonb_build_object('source','list')) AS e
    FROM public.lists l
    WHERE (p_search IS NULL OR l.name ILIKE '%'||p_search||'%')
    ORDER BY l.name LIMIT p_limit
  )
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (SELECT e FROM nl UNION ALL SELECT e FROM ls) x;
$$;

-- 5. Register the subscription source (its predicate fn is unchanged from 004).
INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES (
  'subscription', 'lists', 'Newsletter / list subscription',
  'segments_subscription_to_sql', 'segments_subscription_vocab',
  jsonb_build_object(
    'type','object',
    'required', jsonb_build_array('source','source_id'),
    'properties', jsonb_build_object(
      'source', jsonb_build_object('type','string','enum', jsonb_build_array('newsletter','list')),
      'source_id', jsonb_build_object('type','string','x-entity-source', true)
    )
  ),
  ARRAY['subscribed','not_subscribed'], 10
) ON CONFLICT (kind) DO UPDATE
  SET predicate_fn=EXCLUDED.predicate_fn, vocabulary_fn=EXCLUDED.vocabulary_fn,
      params_schema=EXCLUDED.params_schema, operators=EXCLUDED.operators, label=EXCLUDED.label;
