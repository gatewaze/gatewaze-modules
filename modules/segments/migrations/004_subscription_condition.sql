-- ============================================================================
-- Module: segments
-- Migration: 004_subscription_condition
-- Description: Add a 'subscription' condition type so segments can target people
-- by newsletter/list membership — "everyone subscribed to the User Community
-- newsletter". The engine previously only knew person attributes + behavioural
-- events, so subscription audiences silently matched no one.
--
-- A subscription condition carries a list_id (resolved from a newsletter's
-- associated list, or a list directly) and matches against list_subscriptions:
--   EXISTS (… WHERE ls.person_id = p.id AND ls.list_id = <id> AND ls.subscribed)
-- The newsletter→list resolution (newsletters_template_collections.list_id) is
-- done by the caller (the copilot picks the list_id by name) — the SQL just
-- needs the list_id, which keeps this engine free of a hard dependency on the
-- newsletters/lists modules being installed.
-- ============================================================================

-- A subscription condition references a SOURCE entity, not a hard-coded list:
--   { source: 'newsletter', source_id: <collection_id>, operator: subscribed|not_subscribed }
--   { source: 'list',       source_id: <list_id>,       operator: … }
-- When source='newsletter' the list is resolved LIVE from the newsletter's
-- associated list (newsletters_template_collections.list_id) at query time, so
-- re-pointing the newsletter to a different list automatically follows.
CREATE OR REPLACE FUNCTION public.segments_subscription_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_src  text := COALESCE(cond->>'source', 'list');
  v_id   uuid := NULLIF(cond->>'source_id', '')::uuid;
  v_op   text := COALESCE(cond->>'operator', 'subscribed');
  v_list_expr text;
  v_exists text;
BEGIN
  IF v_id IS NULL THEN
    RETURN 'false';
  END IF;
  -- Degrade gracefully if the lists module isn't installed in this environment.
  IF to_regclass('public.list_subscriptions') IS NULL THEN
    RETURN CASE WHEN v_op = 'not_subscribed' THEN 'true' ELSE 'false' END;
  END IF;

  IF v_src = 'newsletter' THEN
    -- Resolve the list from the newsletter itself (never hard-coded).
    IF to_regclass('public.newsletters_template_collections') IS NULL THEN
      RETURN CASE WHEN v_op = 'not_subscribed' THEN 'true' ELSE 'false' END;
    END IF;
    v_list_expr := format('(SELECT list_id FROM public.newsletters_template_collections WHERE id = %L)', v_id);
  ELSE
    v_list_expr := format('%L::uuid', v_id);
  END IF;

  v_exists := format(
    'EXISTS (SELECT 1 FROM public.list_subscriptions ls WHERE ls.person_id = p.id AND ls.list_id = %s AND ls.subscribed = true)',
    v_list_expr);

  RETURN CASE WHEN v_op = 'not_subscribed' THEN 'NOT ' || v_exists ELSE v_exists END;
END;
$$;

COMMENT ON FUNCTION public.segments_subscription_to_sql(jsonb) IS
  'Translate a subscription condition {source: newsletter|list, source_id, operator} to SQL against list_subscriptions. source=newsletter resolves the list LIVE from newsletters_template_collections.list_id so it follows the newsletter.';

-- Recreate the dispatcher to route type='subscription'. Identical to migration
-- 002 plus the new branch.
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
    ELSIF v_type = 'subscription' THEN
      v_sql := public.segments_subscription_to_sql(v_cond);
    ELSE
      v_sql := public.segments_attr_to_sql(v_cond);
    END IF;
    v_parts := array_append(v_parts, '(' || v_sql || ')');
  END LOOP;

  RETURN '(' || array_to_string(v_parts, v_conn) || ')';
END;
$$;
