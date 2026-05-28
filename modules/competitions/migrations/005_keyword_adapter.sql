-- ============================================================================
-- competitions module — content-keywords adapter (events_competitions)
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[competitions/005_keyword_adapter] content-keywords not installed; skipping';
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

CREATE OR REPLACE FUNCTION public.competitions_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH c AS (SELECT * FROM public.events_competitions WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(title, '')::text, NULL::text FROM c
  UNION ALL
  SELECT 'description'::text, COALESCE(description, '')::text, NULL::text FROM c
  UNION ALL
  SELECT 'prize'::text, COALESCE(prize_description, '')::text, NULL::text FROM c;
$$;

CREATE OR REPLACE FUNCTION public.competitions_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('competition', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('competition', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS competitions_ck_enqueue_trg ON public.events_competitions;
CREATE TRIGGER competitions_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, description, prize_description OR DELETE ON public.events_competitions
  FOR EACH ROW EXECUTE FUNCTION public.competitions_ck_enqueue();

CREATE OR REPLACE FUNCTION public.competitions_public_list(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS SETOF public.events_competitions
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.* FROM public.events_competitions c
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='competition' AND s.content_id=c.id
  WHERE c.status IN ('active','closed','completed')
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='competition'),
                 true) = true
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.competitions_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.competitions_public_list(int, int) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.events_competitions TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.competitions_public_list(int, int) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.competitions_public_list(int, int) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'competition',
    'public.competitions_keyword_text(uuid)'::regprocedure,
    'public.events_competitions'::regclass,
    'created_at',
    ARRAY['title','description','prize'],
    false,
    'Competition',
    true,
    ARRAY['public.competitions_public_list(int,int)'::regprocedure]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'competition', id, 'evaluate' FROM public.events_competitions
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
