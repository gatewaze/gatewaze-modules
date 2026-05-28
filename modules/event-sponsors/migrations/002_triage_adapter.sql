-- ============================================================================
-- event-sponsors — triage adapter
-- Adds status column + registers triage RPCs.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[event-sponsors/002_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  -- Sponsors don't have a publish state; introduce one.
  ALTER TABLE public.events_sponsors ADD COLUMN IF NOT EXISTS status text DEFAULT 'complete';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.events_sponsors'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    ALTER TABLE public.events_sponsors DROP CONSTRAINT IF EXISTS events_sponsors_status_check;
    ALTER TABLE public.events_sponsors ADD CONSTRAINT events_sponsors_status_check
      CHECK (status IN ('pending_review','complete','rejected'));
  END IF;

  ALTER TABLE public.events_sponsors ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

CREATE OR REPLACE FUNCTION public.event_sponsors_triage_approve(
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
  UPDATE public.events_sponsors
     SET status = 'complete',
         is_active = true
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sponsor row % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.event_sponsors_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.events_sponsors
     SET status = 'rejected',
         rejection_reason = p_reason,
         is_active = false
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sponsor row % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.event_sponsors_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Sponsors don't have natural categories; return empty array.
  RETURN QUERY SELECT ARRAY[]::text[], 'none'::text;
END $$;

CREATE OR REPLACE FUNCTION public.event_sponsors_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.events_sponsors
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'complete';
  ELSE
    UPDATE public.events_sponsors
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected');
  END IF;
END $$;

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
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);

  ALTER FUNCTION public.event_sponsors_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_sponsors_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_sponsors_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_sponsors_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'event_sponsor',
    'public.event_sponsors_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.event_sponsors_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.event_sponsors_triage_suggest_categories(uuid)'::regprocedure,
    'public.event_sponsors_triage_submit(uuid,boolean)'::regprocedure,
    'Sponsor'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
