-- ============================================================================
-- event-speakers — triage adapter
-- Registers approve/reject/suggest/submit RPCs with content_triage_adapters.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[event-speakers/005_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  -- Extend status CHECK to include 'pending_review' (already has 'rejected').
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.events_speakers'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    ALTER TABLE public.events_speakers DROP CONSTRAINT IF EXISTS events_speakers_status_check;
    ALTER TABLE public.events_speakers ADD CONSTRAINT events_speakers_status_check
      CHECK (status IN ('pending','approved','confirmed','reserve','rejected','placeholder','pending_review'));
  END IF;

  ALTER TABLE public.events_speakers ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

-- approve: confirm the speaker on the event
CREATE OR REPLACE FUNCTION public.event_speakers_triage_approve(
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
  UPDATE public.events_speakers
     SET status = 'confirmed',
         is_featured = COALESCE(p_featured, is_featured),
         speaker_topic = COALESCE(p_categories[1], speaker_topic)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Speaker assignment % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.event_speakers_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.events_speakers
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Speaker assignment % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.event_speakers_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT ARRAY[e.content_category]::text[], 'event_content_category'::text
    FROM public.events_speakers es
    JOIN public.events e ON e.id = es.event_uuid
    WHERE es.id = p_content_id AND e.content_category IS NOT NULL
    LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION public.event_speakers_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.events_speakers
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'confirmed';
  ELSE
    UPDATE public.events_speakers
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','confirmed');
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

  ALTER FUNCTION public.event_speakers_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_speakers_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_speakers_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.event_speakers_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'event_speaker',
    'public.event_speakers_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.event_speakers_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.event_speakers_triage_suggest_categories(uuid)'::regprocedure,
    'public.event_speakers_triage_submit(uuid,boolean)'::regprocedure,
    'Speaker'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
