-- ============================================================================
-- newsletters — triage adapter
-- Extends newsletters_editions.status with pending_review/rejected + RPCs.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[newsletters/011_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.newsletters_editions'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    ALTER TABLE public.newsletters_editions DROP CONSTRAINT IF EXISTS newsletters_editions_status_check;
    ALTER TABLE public.newsletters_editions ADD CONSTRAINT newsletters_editions_status_check
      CHECK (status IN ('draft','published','archived','pending_review','rejected'));
  END IF;

  ALTER TABLE public.newsletters_editions ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

CREATE OR REPLACE FUNCTION public.newsletters_triage_approve(
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
  UPDATE public.newsletters_editions
     SET status = 'published'
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Newsletter edition % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.newsletters_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.newsletters_editions
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Newsletter edition % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.newsletters_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Newsletter editions don't have a single content category; return empty.
  RETURN QUERY SELECT ARRAY[]::text[], 'none'::text;
END $$;

CREATE OR REPLACE FUNCTION public.newsletters_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.newsletters_editions
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.newsletters_editions
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','published','archived');
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

  ALTER FUNCTION public.newsletters_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.newsletters_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.newsletters_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.newsletters_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'newsletter_edition',
    'public.newsletters_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.newsletters_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.newsletters_triage_suggest_categories(uuid)'::regprocedure,
    'public.newsletters_triage_submit(uuid,boolean)'::regprocedure,
    'Newsletter Edition'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
