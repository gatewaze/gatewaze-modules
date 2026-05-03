-- ============================================================================
-- newsletters — register newsletter_edition with content-platform.
-- ============================================================================

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='newsletters_editions' AND column_name='status'
  ) THEN
    UPDATE public.newsletters_editions SET publish_state = CASE
      WHEN status = 'pending_review' THEN 'pending_review'
      WHEN status = 'rejected'       THEN 'rejected'
      WHEN status = 'archived'       THEN 'unpublished'
      WHEN status = 'draft'          THEN 'draft'
      WHEN status = 'published'      THEN 'published'
      ELSE 'published'
    END WHERE TRUE;
  END IF;
END $backfill$;

CREATE INDEX IF NOT EXISTS newsletters_editions_publish_state_live
  ON public.newsletters_editions(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.newsletters_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT
    COALESCE(NULLIF(e.preheader, ''), 'Edition ' || to_char(e.edition_date, 'YYYY-MM-DD'))::text,
    to_char(e.edition_date, 'YYYY-MM-DD')::text,
    NULL::text
  FROM public.newsletters_editions e WHERE e.id = p_id;
$$;
ALTER FUNCTION public.newsletters_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[newsletters/017] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'newsletter_edition',
    p_table_name        => 'public.newsletters_editions'::regclass,
    p_display_label     => 'Newsletter Edition',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.newsletters_inbox_preview(uuid)'::regprocedure
  );
END $register$;
