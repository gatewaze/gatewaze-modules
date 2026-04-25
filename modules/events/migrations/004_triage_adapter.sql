-- ============================================================================
-- events module — triage adapter
-- Adds pending_review / rejected statuses + registers approve/reject/suggest
-- RPCs with content_triage_adapters.
--
-- Guarded: the whole migration is a no-op if the content_triage_adapters
-- table doesn't exist (content-triage module not installed). Lets this
-- migration ship unconditionally without forcing a hard dependency.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[events/004_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  -- 1. Add status column if missing (legacy events tables may not have one).
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS status text DEFAULT 'complete';

  -- 2. Extend events.status with the triage states, if not already extended.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.events'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    -- Drop and recreate the status CHECK so pending_review + rejected are legal.
    -- Existing values (complete, incomplete) are preserved.
    ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
    ALTER TABLE public.events ADD CONSTRAINT events_status_check
      CHECK (status IN ('complete','incomplete','pending_review','rejected'));
  END IF;

  -- 3. Optional column: rejection reason for admin reference.
  ALTER TABLE public.events ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

-- Outside the DO block: create + register adapter functions unconditionally,
-- but the register INSERT will fail harmlessly if content_triage_adapters is
-- missing — wrap it in its own DO too.

-- ----------------------------------------------------------------------------
-- events_triage_approve — publish event + apply categories, atomically.
-- Signature required by content_triage_adapters: (uuid, text[], boolean, uuid)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_triage_approve(
  p_content_id  uuid,
  p_categories  text[],
  p_featured    boolean,
  p_reviewer    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Primary publish: flip to complete + store primary category.
  -- Multi-category persistence (events_category_links) is deferred until the
  -- categories module lands — keeping this migration self-contained.
  UPDATE public.events
     SET status = 'complete',
         content_category = COALESCE(p_categories[1], content_category)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- events_triage_reject — set status rejected + record reason.
-- Signature: (uuid, text, uuid)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.events
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- events_triage_suggest_categories — read the event's calendar's default
-- category set (when a calendars module is installed and has the column).
-- Signature: (uuid) RETURNS TABLE(categories text[], source text)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only attempt the join if both calendars + default_category_slugs column exist.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'calendars'
      AND column_name = 'default_category_slugs'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'calendars_events'
  ) THEN
    RETURN QUERY
      SELECT COALESCE(c.default_category_slugs, '{}'::text[]), 'calendar_default'::text
      FROM public.events e
      JOIN public.calendars_events ce ON ce.event_id = e.id
      JOIN public.calendars c ON c.id = ce.calendar_id
      WHERE e.id = p_content_id
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Fallback: fall back to existing event content_category single value.
  RETURN QUERY
    SELECT ARRAY[e.content_category]::text[], 'event_content_category'::text
    FROM public.events e
    WHERE e.id = p_content_id AND e.content_category IS NOT NULL
    LIMIT 1;
END $$;

-- ----------------------------------------------------------------------------
-- events_triage_submit — per-type submit hook for reopen flow.
-- Signature: (uuid, boolean) — second arg is p_reopen (true = reopening from approved).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.events
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'complete';
  ELSE
    -- Initial submit: if a scraper set status='complete' via legacy path, flip.
    UPDATE public.events
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','approved');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Transfer ownership to gatewaze_module_writer (required by the adapter
-- registry validation trigger) and register.
-- ----------------------------------------------------------------------------
DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;

  ALTER FUNCTION public.events_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.events_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.events_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.events_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'event',
    'public.events_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.events_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.events_triage_suggest_categories(uuid)'::regprocedure,
    'public.events_triage_submit(uuid,boolean)'::regprocedure,
    'Event'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
