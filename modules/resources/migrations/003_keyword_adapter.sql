-- ============================================================================
-- structured-resources module — content-keywords adapter (sr_items)
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[structured-resources/003_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $migration$;

CREATE OR REPLACE FUNCTION public.sr_items_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH i AS (
    SELECT i.*, c.slug AS collection_slug FROM public.sr_items i
    LEFT JOIN public.sr_collections c ON c.id = i.collection_id
    WHERE i.id = p_content_id
  ),
       sections AS (
         SELECT item_id, string_agg(content, ' ') AS body
         FROM public.sr_sections WHERE item_id = p_content_id
         GROUP BY item_id
       )
  SELECT 'title'::text, COALESCE(title, '')::text, NULLIF(collection_slug, '')::text FROM i
  UNION ALL
  SELECT 'subtitle'::text, COALESCE(subtitle, '')::text, NULLIF(collection_slug, '')::text FROM i
  UNION ALL
  SELECT 'sections'::text, COALESCE(s.body, '')::text, NULLIF(i.collection_slug, '')::text
    FROM i LEFT JOIN sections s ON s.item_id = i.id;
$$;

CREATE OR REPLACE FUNCTION public.sr_items_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('sr_item', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('sr_item', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS sr_items_ck_enqueue_trg ON public.sr_items;
CREATE TRIGGER sr_items_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, subtitle OR DELETE ON public.sr_items
  FOR EACH ROW EXECUTE FUNCTION public.sr_items_ck_enqueue();

CREATE OR REPLACE FUNCTION public.sr_items_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_collection_slug text DEFAULT NULL
) RETURNS SETOF public.sr_items
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.* FROM public.sr_items i
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='sr_item' AND s.content_id=i.id
  LEFT JOIN public.sr_collections c ON c.id = i.collection_id
  WHERE i.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='sr_item'),
                 true) = true
    AND (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ORDER BY i.sort_order, i.created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.sr_items_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.sr_items_public_list(int, int, text) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.sr_items, public.sr_collections, public.sr_sections TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.sr_items_public_list(int, int, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.sr_items_public_list(int, int, text) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'sr_item',
    'public.sr_items_keyword_text(uuid)'::regprocedure,
    'public.sr_items'::regclass,
    'created_at',
    ARRAY['title','subtitle','sections'],
    true,
    'Resource',
    true,
    ARRAY['public.sr_items_public_list(int,int,text)'::regprocedure]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'sr_item', id, 'evaluate' FROM public.sr_items
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
