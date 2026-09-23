-- ============================================================================
-- Module: segments
-- Migration: 016_email_engagement_condition
-- Description: Add an 'email_engagement' condition source so audiences can be
-- built (and excluded) by what a person has been SENT, has OPENED, or has
-- CLICKED for a specific broadcast or newsletter edition — e.g. "exclude
-- everyone already sent the AGNTCon broadcast", or "include people who clicked
-- the last newsletter". Registered on the condition-source registry (005), so
-- the copilot, the JSON-Schema tool, and the manual builder all pick it up
-- with no other code change.
--
-- The picked entity id is namespaced ('broadcast:<id>' / 'newsletter:<id>') so
-- one picker fully determines both the campaign and its type. The operator
-- encodes the action AND the polarity (was_sent/not_sent/opened/not_opened/
-- clicked/not_clicked), so the whole condition is one dropdown + one picker.
--
-- Matching is over email_send_log (which carries broadcast_send_id,
-- newsletter_send_id, sent_at, first_opened_at, first_clicked_at), joined to the
-- person by lowercased email — the planner drives from the campaign's send rows
-- via the *_send_id indexes, so it stays fast. to_regclass-guarded so it degrades
-- gracefully where the emailing tables aren't installed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_email_engagement_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw    text := cond->>'source_id';
  v_op     text := COALESCE(cond->>'operator', 'was_sent');
  v_neg    boolean := v_op IN ('not_sent', 'not_opened', 'not_clicked');
  v_act    text := CASE
                     WHEN v_op IN ('opened', 'not_opened')   THEN 'opened'
                     WHEN v_op IN ('clicked', 'not_clicked') THEN 'clicked'
                     ELSE 'sent'
                   END;
  v_kind   text;
  v_id     uuid;
  v_filter text;
  v_action text;
  v_exists text;
BEGIN
  -- Unconfigured / degraded: an include matches nobody, an exclude excludes
  -- nobody — never accidentally zeroes or opens up the whole audience.
  IF v_raw IS NULL OR position(':' in v_raw) = 0
     OR to_regclass('public.email_send_log') IS NULL THEN
    RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
  END IF;

  v_kind := split_part(v_raw, ':', 1);
  BEGIN
    v_id := split_part(v_raw, ':', 2)::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
  END;

  IF v_kind = 'broadcast' THEN
    IF to_regclass('public.broadcast_sends') IS NULL THEN RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END; END IF;
    v_filter := format('esl.broadcast_send_id IN (SELECT id FROM public.broadcast_sends WHERE broadcast_id = %L)', v_id);
  ELSIF v_kind = 'newsletter' THEN
    IF to_regclass('public.newsletter_sends') IS NULL THEN RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END; END IF;
    v_filter := format('esl.newsletter_send_id IN (SELECT id FROM public.newsletter_sends WHERE edition_id = %L)', v_id);
  ELSE
    RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
  END IF;

  v_action := CASE v_act
                WHEN 'opened'  THEN 'esl.first_opened_at IS NOT NULL'
                WHEN 'clicked' THEN 'esl.first_clicked_at IS NOT NULL'
                ELSE 'esl.sent_at IS NOT NULL'
              END;

  v_exists := format(
    'EXISTS (SELECT 1 FROM public.email_send_log esl WHERE lower(esl.recipient_email) = lower(p.email) AND %s AND %s)',
    v_filter, v_action);

  RETURN CASE WHEN v_neg THEN 'NOT ' || v_exists ELSE v_exists END;
END;
$$;

COMMENT ON FUNCTION public.segments_email_engagement_to_sql(jsonb) IS
  'Translate an email_engagement condition {source_id: broadcast:<id>|newsletter:<id>, operator: was_sent|not_sent|opened|not_opened|clicked|not_clicked} to an EXISTS/NOT EXISTS over email_send_log.';

-- Vocabulary: sent broadcasts + sent newsletter editions, namespaced ids.
CREATE OR REPLACE FUNCTION public.segments_email_engagement_vocab(p_search text DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH bc AS (
    SELECT jsonb_build_object(
             'id', 'broadcast:' || b.id,
             'label', b.name || ' (broadcast)',
             'extra', jsonb_build_object('source', 'broadcast')
           ) AS e
    FROM public.broadcasts b
    WHERE EXISTS (SELECT 1 FROM public.broadcast_sends s WHERE s.broadcast_id = b.id AND s.status IN ('sent', 'completed'))
      AND (p_search IS NULL OR b.name ILIKE '%' || p_search || '%')
    ORDER BY b.created_at DESC
    LIMIT p_limit
  ), nl AS (
    SELECT jsonb_build_object(
             'id', 'newsletter:' || ed.id,
             'label', COALESCE(NULLIF(ed.title, ''), ed.edition_date::text) || ' (newsletter)',
             'extra', jsonb_build_object('source', 'newsletter')
           ) AS e
    FROM public.newsletters_editions ed
    WHERE EXISTS (SELECT 1 FROM public.newsletter_sends s WHERE s.edition_id = ed.id AND s.completed_at IS NOT NULL)
      AND (p_search IS NULL OR COALESCE(ed.title, '') ILIKE '%' || p_search || '%')
    ORDER BY ed.edition_date DESC
    LIMIT p_limit
  )
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (SELECT e FROM bc UNION ALL SELECT e FROM nl) x;
$$;

-- Register the source. Picked up automatically by segments_sources_catalog.
INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES (
  'email_engagement', 'broadcasts', 'Broadcast / newsletter engagement',
  'segments_email_engagement_to_sql', 'segments_email_engagement_vocab',
  jsonb_build_object(
    'type', 'object',
    'required', jsonb_build_array('source_id'),
    'properties', jsonb_build_object(
      'source_id', jsonb_build_object('type', 'string', 'x-entity-source', true)
    )
  ),
  ARRAY['was_sent', 'not_sent', 'opened', 'not_opened', 'clicked', 'not_clicked'],
  20
) ON CONFLICT (kind) DO UPDATE
  SET predicate_fn = EXCLUDED.predicate_fn, vocabulary_fn = EXCLUDED.vocabulary_fn,
      params_schema = EXCLUDED.params_schema, operators = EXCLUDED.operators,
      label = EXCLUDED.label, module_id = EXCLUDED.module_id;
