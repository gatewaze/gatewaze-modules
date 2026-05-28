-- ============================================================================
-- content-keywords — emit verdict changes to content_publish_state_event_queue
-- After ck_evaluate_item writes its verdict, enqueue a row so the events
-- verdict-handler worker can propagate is_visible into events.publish_state.
--
-- Soft: no-op if the events module hasn't deployed the queue table yet.
--
-- See spec-content-publishing-pipeline.md §4.3.0.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ck_evaluate_item(
  p_content_type text,
  p_content_id   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version       bigint;
  v_eval          record;
  v_prev_visible  boolean;
  v_has_queue     boolean;
BEGIN
  SELECT version INTO v_version
  FROM public.content_keyword_ruleset_versions
  WHERE content_type = p_content_type;
  IF NOT FOUND THEN v_version := 1; END IF;

  -- Snapshot prior state so we can detect transitions.
  SELECT is_visible INTO v_prev_visible
    FROM public.content_keyword_item_state
   WHERE content_type = p_content_type AND content_id = p_content_id;

  SELECT * INTO v_eval FROM public.ck_evaluate_inner(p_content_type, p_content_id);

  INSERT INTO public.content_keyword_item_state
    (content_type, content_id, is_visible, matched_rule_ids, evaluated_at, ruleset_version)
  VALUES (p_content_type, p_content_id, v_eval.v_is_visible, v_eval.v_matched, now(), v_version)
  ON CONFLICT (content_type, content_id) DO UPDATE
    SET is_visible       = EXCLUDED.is_visible,
        matched_rule_ids = EXCLUDED.matched_rule_ids,
        evaluated_at     = EXCLUDED.evaluated_at,
        ruleset_version  = EXCLUDED.ruleset_version;

  -- Emit a verdict-change event when:
  --   - first evaluation (v_prev_visible IS NULL), or
  --   - transition between true/false.
  v_has_queue := EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_state_event_queue'
  );

  IF v_has_queue AND (v_prev_visible IS NULL OR v_prev_visible IS DISTINCT FROM v_eval.v_is_visible) THEN
    INSERT INTO public.content_publish_state_event_queue
      (content_type, content_id, trigger, payload)
    VALUES (
      p_content_type, p_content_id, 'keyword_verdict',
      jsonb_build_object('is_visible', v_eval.v_is_visible,
                         'previous',   v_prev_visible)
    );
  END IF;
END $$;
ALTER FUNCTION public.ck_evaluate_item(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.ck_evaluate_item(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ck_evaluate_item(text, uuid) TO service_role;

-- Install the universal category-sync trigger if content-platform is present.
-- Safe to re-run; content-platform's migration also installs it but skips if
-- content_keyword_item_state didn't exist yet at that time.
DO $trg$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cm_category_sync_universal') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS cm_category_sync_universal_trg ON public.content_keyword_item_state';
    EXECUTE 'CREATE TRIGGER cm_category_sync_universal_trg
             AFTER INSERT OR UPDATE OF matched_rule_ids ON public.content_keyword_item_state
             FOR EACH ROW EXECUTE FUNCTION public.cm_category_sync_universal()';
  END IF;
END $trg$;
