-- ============================================================================
-- videos module — content-triage adapter (approve/reject/suggest/submit).
-- Signatures mirror the blog adapter so the generic triage caller invokes them
-- identically. Guarded no-ops if content-triage isn't installed.
-- ============================================================================

-- approve: publish + set category (first of p_categories). p_featured is
-- accepted for caller-signature parity with blog and ignored (videos have no
-- featured flag).
CREATE OR REPLACE FUNCTION public.video_triage_approve(
  p_content_id uuid,
  p_categories text[],
  p_featured   boolean,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.videos
     SET status = 'published',
         publish_state = 'published',
         content_category = COALESCE(p_categories[1], content_category)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Video % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.video_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.videos
     SET status = 'rejected', publish_state = 'rejected', rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Video % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.video_triage_suggest_categories(p_content_id uuid)
RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT ARRAY[v.content_category]::text[], 'content_category'::text
    FROM public.videos v
    WHERE v.id = p_content_id AND v.content_category IS NOT NULL
    LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION public.video_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.videos SET status = 'pending_review', publish_state = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.videos SET status = 'pending_review', publish_state = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','published','archived');
  END IF;
END $$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_triage_adapters'
  ) THEN RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);

  ALTER FUNCTION public.video_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.video_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.video_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.video_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'video',
    'public.video_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.video_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.video_triage_suggest_categories(uuid)'::regprocedure,
    'public.video_triage_submit(uuid,boolean)'::regprocedure,
    'Video'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn = EXCLUDED.approve_fn, reject_fn = EXCLUDED.reject_fn,
    suggest_fn = EXCLUDED.suggest_fn, submit_fn = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
