-- ============================================================================
-- structured-resources — triage adapter
-- Triage RPCs (approve/reject/submit/suggest). The sr_items schema this relies
-- on (extended status CHECK, rejection_reason) is created up-front in
-- 001_structured_resources.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sr_items_triage_approve(
  p_content_id  uuid,
  p_categories  text[],
  p_featured    boolean,
  p_reviewer    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category_id uuid;
  v_collection_id uuid;
BEGIN
  SELECT collection_id INTO v_collection_id FROM public.sr_items WHERE id = p_content_id;
  IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 AND v_collection_id IS NOT NULL THEN
    SELECT id INTO v_category_id
      FROM public.sr_categories
     WHERE collection_id = v_collection_id AND slug = p_categories[1]
     LIMIT 1;
  END IF;

  UPDATE public.sr_items
     SET status = 'published',
         category_id = COALESCE(v_category_id, category_id)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource item % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sr_items_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.sr_items
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource item % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sr_items_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT ARRAY[c.slug]::text[], 'sr_category'::text
    FROM public.sr_items i
    JOIN public.sr_categories c ON c.id = i.category_id
    WHERE i.id = p_content_id
    LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION public.sr_items_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.sr_items
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.sr_items
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

  ALTER FUNCTION public.sr_items_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.sr_items_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.sr_items_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.sr_items_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'sr_item',
    'public.sr_items_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.sr_items_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.sr_items_triage_suggest_categories(uuid)'::regprocedure,
    'public.sr_items_triage_submit(uuid,boolean)'::regprocedure,
    'Resource'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
