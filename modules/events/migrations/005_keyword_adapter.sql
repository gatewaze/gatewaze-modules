-- ============================================================================
-- events module — content-keywords adapter
-- Registers events as a content-keywords adapter, installs trigger,
-- defines public read functions. Guarded: no-op if content-keywords
-- isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_adapters'
  ) THEN
    RAISE NOTICE '[events/005_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);

  -- events.status may not exist on databases where the triage adapter
  -- migration didn't add it (different content-triage install order).
  -- The read functions reference it, so ensure it's present.
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS status text DEFAULT 'complete';
END $migration$;

-- ----------------------------------------------------------------------------
-- Adapter text function: returns (field, value, source) tuples for matching.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH e AS (SELECT * FROM public.events WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(event_title, '')::text, NULLIF(event_source_name, '')::text FROM e
  UNION ALL
  SELECT 'body'::text,  COALESCE(event_description, '')::text, NULLIF(event_source_name, '')::text FROM e
  UNION ALL
  SELECT 'host'::text,  COALESCE(event_source_name, '')::text, NULL::text FROM e
  UNION ALL
  SELECT 'topics'::text, COALESCE(array_to_string(event_topics, ' '), '')::text, NULLIF(event_source_name, '')::text FROM e;
$$;

-- ----------------------------------------------------------------------------
-- Trigger: enqueue match work on insert/update of keyword-relevant columns
-- and on delete.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('event', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'delete', enqueued_at = now(), next_attempt_at = now(),
            attempts = 0, last_error = NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('event', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'evaluate', enqueued_at = now(), next_attempt_at = now(),
            attempts = 0, last_error = NULL;
    RETURN NEW;
  END IF;
END $$;

DROP TRIGGER IF EXISTS events_ck_enqueue_trg ON public.events;
CREATE TRIGGER events_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF event_title, event_description, event_source_name, event_topics
                          OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_ck_enqueue();

-- ----------------------------------------------------------------------------
-- Public read functions (visibility-aware). All public reads MUST go
-- through these instead of selecting from events directly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_public_list(
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_city text DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
) RETURNS SETOF public.events
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.*
  FROM public.events e
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'event' AND s.content_id = e.id
  WHERE COALESCE(e.status, 'complete') = 'complete'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules
                  FROM public.content_keyword_adapters
                  WHERE content_type = 'event'),
                 true) = true
    AND (p_city IS NULL OR e.event_city ILIKE '%' || p_city || '%')
    AND (p_country_code IS NULL OR e.event_country_code = p_country_code)
    AND (p_from IS NULL OR e.event_start >= p_from)
    AND (p_to IS NULL OR e.event_start < p_to)
  ORDER BY e.event_start DESC NULLS LAST, e.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

CREATE OR REPLACE FUNCTION public.events_public_get(p_id uuid)
RETURNS SETOF public.events
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.*
  FROM public.events e
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'event' AND s.content_id = e.id
  WHERE e.id = p_id
    AND COALESCE(e.status, 'complete') = 'complete'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules
                  FROM public.content_keyword_adapters
                  WHERE content_type = 'event'),
                 true) = true;
$$;

-- ----------------------------------------------------------------------------
-- Ownership transfer + adapter registration.
-- ----------------------------------------------------------------------------
DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_adapters'
  ) THEN
    RETURN;
  END IF;

  ALTER FUNCTION public.events_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.events_public_list(int, int, text, text, timestamptz, timestamptz) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.events_public_get(uuid) OWNER TO gatewaze_module_writer;

  -- The adapter's SECURITY DEFINER text_fn + the scanner / read functions
  -- need SELECT on events (and the queue worker doesn't run as service_role
  -- from inside the DB).
  GRANT SELECT ON public.events TO gatewaze_module_writer;

  -- Restrict + grant execute to anon/authenticated for public read fns.
  REVOKE ALL ON FUNCTION public.events_public_list(int, int, text, text, timestamptz, timestamptz) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.events_public_list(int, int, text, text, timestamptz, timestamptz) TO anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.events_public_get(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.events_public_get(uuid) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column,
     declared_fields, declares_source, display_label,
     default_visible_when_no_rules, public_read_fns)
  VALUES (
    'event',
    'public.events_keyword_text(uuid)'::regprocedure,
    'public.events'::regclass,
    'created_at',
    ARRAY['title', 'body', 'host', 'topics'],
    true,
    'Event',
    true,
    ARRAY[
      'public.events_public_list(int,int,text,text,timestamptz,timestamptz)'::regprocedure,
      'public.events_public_get(uuid)'::regprocedure
    ]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn,
    table_name = EXCLUDED.table_name,
    created_at_column = EXCLUDED.created_at_column,
    declared_fields = EXCLUDED.declared_fields,
    declares_source = EXCLUDED.declares_source,
    display_label = EXCLUDED.display_label,
    default_visible_when_no_rules = EXCLUDED.default_visible_when_no_rules,
    public_read_fns = EXCLUDED.public_read_fns;
END
$register$;

-- ----------------------------------------------------------------------------
-- Backfill: enqueue every existing event for evaluation.
-- ----------------------------------------------------------------------------
DO $backfill$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_match_queue'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'event', id, 'evaluate' FROM public.events
  ON CONFLICT (content_type, content_id) DO NOTHING;
END
$backfill$;
