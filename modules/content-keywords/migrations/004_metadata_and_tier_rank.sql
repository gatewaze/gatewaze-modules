-- ============================================================================
-- content-keywords — add metadata jsonb + match_tier_rank int (rev I)
-- Enables external modules (membership, etc.) to attach per-rule metadata
-- and have the evaluator pick the highest tier_rank across matched rules.
-- ============================================================================

ALTER TABLE public.content_keyword_rules
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.content_keyword_item_state
  ADD COLUMN IF NOT EXISTS match_tier_rank int;

CREATE INDEX IF NOT EXISTS idx_ckis_tier_rank
  ON public.content_keyword_item_state (content_type, match_tier_rank DESC NULLS LAST)
  WHERE is_visible;

-- Replace ck_evaluate_inner to also compute tier_rank from rule metadata.
-- Highest rank across matched rules wins.
DROP FUNCTION IF EXISTS public.ck_evaluate_inner(text, uuid) CASCADE;
CREATE OR REPLACE FUNCTION public.ck_evaluate_inner(
  p_content_type text,
  p_content_id   uuid,
  OUT v_is_visible    boolean,
  OUT v_matched       uuid[],
  OUT v_tier_rank     int
) RETURNS record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adapter    record;
  v_default    boolean;
  r_rule       record;
  v_text_rec   record;
  v_match      boolean;
  v_text_query text;
  v_pattern    text;
  v_op         text;
  v_rule_rank  int;
BEGIN
  v_matched := ARRAY[]::uuid[];
  v_tier_rank := NULL;

  SELECT * INTO v_adapter FROM public.content_keyword_adapters
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing_adapter:%', p_content_type USING ERRCODE = '22023';
  END IF;
  v_default := v_adapter.default_visible_when_no_rules;

  IF NOT EXISTS (
    SELECT 1 FROM public.content_keyword_rules
    WHERE p_content_type = ANY(content_types) AND is_active
  ) THEN
    v_is_visible := v_default;
    RETURN;
  END IF;

  FOR r_rule IN
    SELECT * FROM public.content_keyword_rules
    WHERE p_content_type = ANY(content_types) AND is_active
    ORDER BY id
  LOOP
    v_match := false;
    v_pattern := r_rule.pattern;
    v_op := CASE r_rule.pattern_type
      WHEN 'substring' THEN CASE WHEN r_rule.case_sensitive THEN 'pos' ELSE 'pos_ci' END
      WHEN 'word'      THEN CASE WHEN r_rule.case_sensitive THEN 'word_cs' ELSE 'word_ci' END
      WHEN 'regex'     THEN CASE WHEN r_rule.case_sensitive THEN 'regex_cs' ELSE 'regex_ci' END
    END;

    v_text_query := format(
      'SELECT field, value, source FROM %s($1) WHERE value IS NOT NULL AND value <> %L',
      v_adapter.text_fn::regproc::text, '');
    FOR v_text_rec IN EXECUTE v_text_query USING p_content_id LOOP
      IF r_rule.sources IS NOT NULL THEN
        IF v_text_rec.source IS NULL OR NOT (v_text_rec.source = ANY(r_rule.sources)) THEN
          CONTINUE;
        END IF;
      END IF;
      IF r_rule.fields <> ARRAY['any'] THEN
        IF NOT (v_text_rec.field = ANY(r_rule.fields)) THEN
          CONTINUE;
        END IF;
      END IF;

      v_match := CASE v_op
        WHEN 'pos'      THEN position(v_pattern in v_text_rec.value) > 0
        WHEN 'pos_ci'   THEN position(lower(v_pattern) in lower(v_text_rec.value)) > 0
        WHEN 'word_cs'  THEN v_text_rec.value ~  ('\m' || regexp_replace(v_pattern, '([.\^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
        WHEN 'word_ci'  THEN v_text_rec.value ~* ('\m' || regexp_replace(v_pattern, '([.\^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
        WHEN 'regex_cs' THEN v_text_rec.value ~  v_pattern
        WHEN 'regex_ci' THEN v_text_rec.value ~* v_pattern
      END;

      IF v_match THEN
        v_matched := v_matched || r_rule.id;
        -- Pick up tier_rank from the rule's metadata, track max.
        v_rule_rank := NULLIF(r_rule.metadata->>'tier_rank', '')::int;
        IF v_rule_rank IS NOT NULL AND (v_tier_rank IS NULL OR v_rule_rank > v_tier_rank) THEN
          v_tier_rank := v_rule_rank;
        END IF;
        EXIT;
      END IF;
    END LOOP;

    IF array_length(v_matched, 1) >= 50 THEN EXIT; END IF;
  END LOOP;

  v_matched := ARRAY(SELECT unnest(v_matched) ORDER BY 1);
  v_is_visible := COALESCE(array_length(v_matched, 1), 0) > 0;
END $$;
ALTER FUNCTION public.ck_evaluate_inner(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_evaluate_inner(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_evaluate_inner(text, uuid) TO service_role;

-- Update ck_evaluate_item to write match_tier_rank.
CREATE OR REPLACE FUNCTION public.ck_evaluate_item(
  p_content_type text,
  p_content_id   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version  bigint;
  v_eval     record;
BEGIN
  SELECT version INTO v_version
  FROM public.content_keyword_ruleset_versions
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN v_version := 1; END IF;

  SELECT * INTO v_eval FROM public.ck_evaluate_inner(p_content_type, p_content_id);

  INSERT INTO public.content_keyword_item_state
    (content_type, content_id, is_visible, matched_rule_ids, evaluated_at, ruleset_version, match_tier_rank)
  VALUES (p_content_type, p_content_id, v_eval.v_is_visible, v_eval.v_matched, now(), v_version, v_eval.v_tier_rank)
  ON CONFLICT (content_type, content_id) DO UPDATE
    SET is_visible       = EXCLUDED.is_visible,
        matched_rule_ids = EXCLUDED.matched_rule_ids,
        evaluated_at     = EXCLUDED.evaluated_at,
        ruleset_version  = EXCLUDED.ruleset_version,
        match_tier_rank  = EXCLUDED.match_tier_rank;
END $$;
ALTER FUNCTION public.ck_evaluate_item(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_evaluate_item(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_evaluate_item(text, uuid) TO service_role;
