-- ============================================================================
-- competitions — register competition with content-platform.
-- ============================================================================

ALTER TABLE public.events_competitions
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  -- competitions has its own status enum (draft/active/closed/completed); 004 added
  -- pending_review/rejected. Map active+completed → published; draft → draft;
  -- closed → unpublished; pending_review/rejected pass through.
  UPDATE public.events_competitions SET publish_state = CASE
    WHEN status = 'pending_review' THEN 'pending_review'
    WHEN status = 'rejected'       THEN 'rejected'
    WHEN status = 'draft'          THEN 'draft'
    WHEN status = 'closed'         THEN 'unpublished'
    ELSE 'published'  -- active, completed, anything else
  END WHERE TRUE;
END $backfill$;

CREATE INDEX IF NOT EXISTS events_competitions_publish_state_live
  ON public.events_competitions(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.competitions_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT c.title::text,
         NULLIF(LEFT(COALESCE(c.description, c.intro, ''), 140), '')::text,
         NULL::text
  FROM public.events_competitions c WHERE c.id = p_id;
$$;
ALTER FUNCTION public.competitions_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[competitions/005] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'competition',
    p_table_name        => 'public.events_competitions'::regclass,
    p_display_label     => 'Competition',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.competitions_inbox_preview(uuid)'::regprocedure
  );
END $register$;
