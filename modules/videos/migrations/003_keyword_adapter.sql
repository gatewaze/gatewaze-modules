-- ============================================================================
-- videos module — content-keywords adapter (topic tagging + member/keyword
-- visibility). Guarded: no-op if content-keywords isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_adapters'
  ) THEN
    RAISE NOTICE '[videos/003_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $migration$;

CREATE OR REPLACE FUNCTION public.videos_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH v AS (SELECT * FROM public.videos WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(title, '')::text, NULL::text FROM v
  UNION ALL
  SELECT 'body'::text, COALESCE(description, '')::text, NULL::text FROM v
  UNION ALL
  SELECT 'speakers'::text,
         COALESCE((SELECT string_agg(s->>'name', ' ') FROM v, jsonb_array_elements(v.speakers) s), '')::text,
         NULL::text FROM v;
$$;

CREATE OR REPLACE FUNCTION public.videos_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('video', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'delete', enqueued_at = now(), next_attempt_at = now(), attempts = 0, last_error = NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('video', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'evaluate', enqueued_at = now(), next_attempt_at = now(), attempts = 0, last_error = NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS videos_ck_enqueue_trg ON public.videos;
CREATE TRIGGER videos_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, description, speakers OR DELETE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.videos_ck_enqueue();

CREATE OR REPLACE FUNCTION public.videos_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_category text DEFAULT NULL
) RETURNS SETOF public.videos
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.* FROM public.videos v
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'video' AND s.content_id = v.id
  WHERE v.status = 'published' AND v.visibility = 'public'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='video'),
                 true) = true
    AND (p_category IS NULL OR v.content_category = p_category)
  ORDER BY v.published_at DESC NULLS LAST, v.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

CREATE OR REPLACE FUNCTION public.videos_public_get(p_id uuid)
RETURNS SETOF public.videos
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.* FROM public.videos v
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'video' AND s.content_id = v.id
  WHERE v.id = p_id AND v.status = 'published' AND v.visibility = 'public'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='video'),
                 true) = true;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.videos_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.videos_public_list(int, int, text) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.videos_public_get(uuid) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.videos TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.videos_public_list(int, int, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.videos_public_list(int, int, text) TO anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.videos_public_get(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.videos_public_get(uuid) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'video',
    'public.videos_keyword_text(uuid)'::regprocedure,
    'public.videos'::regclass,
    'created_at',
    ARRAY['title','body','speakers'],
    false,
    'Video',
    true,
    ARRAY[
      'public.videos_public_list(int,int,text)'::regprocedure,
      'public.videos_public_get(uuid)'::regprocedure
    ]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'video', id, 'evaluate' FROM public.videos
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
