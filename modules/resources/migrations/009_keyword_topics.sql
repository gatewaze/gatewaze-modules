-- 009: dynamic topics via the content-keywords rules engine.
--
-- Registers sr_blocks as a keyword-adapter content type (the block's
-- search_text is already a clean plain-text projection) and syncs matched
-- topic rules into the content the related-content resolver reads:
--
--   * rules that carry metadata->>'topic_slug' are TOPIC rules; other rules
--     (e.g. member detection) are ignored by this sync
--   * sr_blocks: matched slugs land in data.topics_auto — a separate key so
--     hand-set data.topics stays canonical, the admin editor stays honest,
--     and the search_text projection contract (manual topics only) is
--     untouched. Rule changes fully recompute topics_auto.
--   * events: matched slugs merge additively into event_topics (that array
--     is already the resolver's event-matching surface).
--
-- Safe when content-keywords isn't installed: everything no-ops.

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[resources/009_keyword_topics] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $migration$;

-- ── Text extraction: blocks project through search_text (plus the talk title
--    as its own field so title-scoped rules are possible) ────────────────────
CREATE OR REPLACE FUNCTION public.sr_blocks_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH b AS (
    SELECT b.*, c.slug AS collection_slug
    FROM public.sr_blocks b
    JOIN public.sr_items i ON i.id = b.item_id
    LEFT JOIN public.sr_collections c ON c.id = i.collection_id
    WHERE b.id = p_content_id
  )
  SELECT 'title'::text, COALESCE(b.data->>'title', '')::text, NULLIF(b.collection_slug, '')::text FROM b
  UNION ALL
  SELECT 'text'::text, COALESCE(b.search_text, '')::text, NULLIF(b.collection_slug, '')::text FROM b;
$$;

CREATE OR REPLACE FUNCTION public.sr_blocks_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('sr_block', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('sr_block', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS sr_blocks_ck_enqueue_trg ON public.sr_blocks;
CREATE TRIGGER sr_blocks_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF search_text OR DELETE ON public.sr_blocks
  FOR EACH ROW EXECUTE FUNCTION public.sr_blocks_ck_enqueue();

-- ── Topic sync: keyword match state -> content topic fields ─────────────────
-- Runs when the engine writes evaluation results. SECURITY DEFINER because
-- the state writer (worker/service) must reach sr_blocks/events regardless
-- of its own grants; the function only derives topics from active rules.
CREATE OR REPLACE FUNCTION public.ck_topic_slugs(p_rule_ids uuid[])
RETURNS text[]
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT r.metadata->>'topic_slug' ORDER BY r.metadata->>'topic_slug'), '{}')
  FROM public.content_keyword_rules r
  WHERE r.id = ANY(COALESCE(p_rule_ids, '{}'))
    AND r.is_active
    AND r.metadata ? 'topic_slug'
    AND r.metadata->>'topic_slug' ~ '^[a-z0-9][a-z0-9-]{0,60}$';
$$;

CREATE OR REPLACE FUNCTION public.ck_topics_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  slugs text[];
BEGIN
  IF NEW.content_type = 'sr_block' THEN
    slugs := public.ck_topic_slugs(NEW.matched_rule_ids);
    UPDATE public.sr_blocks
    SET data = CASE
      WHEN COALESCE(array_length(slugs, 1), 0) = 0 THEN data - 'topics_auto'
      ELSE jsonb_set(data, '{topics_auto}', to_jsonb(slugs))
    END
    WHERE id = NEW.content_id
      AND COALESCE(data->'topics_auto', '[]'::jsonb) IS DISTINCT FROM COALESCE(to_jsonb(slugs), '[]'::jsonb);
  ELSIF NEW.content_type = 'event' THEN
    slugs := public.ck_topic_slugs(NEW.matched_rule_ids);
    IF COALESCE(array_length(slugs, 1), 0) > 0 THEN
      -- additive: event_topics also holds scraper/manual values we must keep
      UPDATE public.events
      SET event_topics = (
        SELECT array_agg(DISTINCT t) FROM unnest(COALESCE(event_topics, '{}') || slugs) AS t
      )
      WHERE id = NEW.content_id
        AND NOT (COALESCE(event_topics, '{}') @> slugs);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ck_topics_sync_trg ON public.content_keyword_item_state;
CREATE TRIGGER ck_topics_sync_trg
  AFTER INSERT OR UPDATE OF matched_rule_ids ON public.content_keyword_item_state
  FOR EACH ROW EXECUTE FUNCTION public.ck_topics_sync();

-- rule-derived topics get their own containment index, mirroring the manual one
CREATE INDEX IF NOT EXISTS sr_blocks_topics_auto_gin
  ON public.sr_blocks USING gin ((data -> 'topics_auto') jsonb_path_ops)
  WHERE jsonb_typeof(data -> 'topics_auto') = 'array';

-- ── Register the adapter + backfill the evaluation queue ────────────────────
DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.sr_blocks_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.sr_blocks, public.sr_items, public.sr_collections TO gatewaze_module_writer;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'sr_block',
    'public.sr_blocks_keyword_text(uuid)'::regprocedure,
    'public.sr_blocks'::regclass,
    'created_at',
    ARRAY['title','text'],
    true,
    'Resource block',
    true,
    ARRAY[]::regprocedure[]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'sr_block', id, 'evaluate' FROM public.sr_blocks
  ON CONFLICT (content_type, content_id) DO NOTHING;
  -- events already have an adapter; re-enqueue them so topic rules apply
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'event', id, 'evaluate' FROM public.events
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
