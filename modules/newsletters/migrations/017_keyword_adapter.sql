-- ============================================================================
-- newsletters module — content-keywords adapter
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[newsletters/017_keyword_adapter] content-keywords not installed; skipping';
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

CREATE OR REPLACE FUNCTION public.newsletters_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH n AS (SELECT * FROM public.newsletters_editions WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(title, '')::text, NULL::text FROM n
  UNION ALL
  SELECT 'preheader'::text, COALESCE(preheader, '')::text, NULL::text FROM n;
$$;

CREATE OR REPLACE FUNCTION public.newsletters_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('newsletter_edition', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('newsletter_edition', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS newsletters_ck_enqueue_trg ON public.newsletters_editions;
CREATE TRIGGER newsletters_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, preheader OR DELETE ON public.newsletters_editions
  FOR EACH ROW EXECUTE FUNCTION public.newsletters_ck_enqueue();

CREATE OR REPLACE FUNCTION public.newsletters_public_list(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS SETOF public.newsletters_editions
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT n.* FROM public.newsletters_editions n
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='newsletter_edition' AND s.content_id=n.id
  WHERE n.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='newsletter_edition'),
                 true) = true
  ORDER BY n.edition_date DESC NULLS LAST, n.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.newsletters_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.newsletters_public_list(int, int) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.newsletters_editions TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.newsletters_public_list(int, int) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.newsletters_public_list(int, int) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'newsletter_edition',
    'public.newsletters_keyword_text(uuid)'::regprocedure,
    'public.newsletters_editions'::regclass,
    'created_at',
    ARRAY['title','preheader'],
    false,
    'Newsletter Edition',
    true,
    ARRAY['public.newsletters_public_list(int,int)'::regprocedure]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'newsletter_edition', id, 'evaluate' FROM public.newsletters_editions
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
