-- ============================================================================
-- structured-resources — register sr_item with content-platform.
-- ============================================================================

ALTER TABLE public.sr_items
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  -- sr_items.status enum is (draft/published/archived). 002_triage_adapter may
  -- have widened it; backfill conservatively.
  UPDATE public.sr_items SET publish_state = CASE
    WHEN status = 'pending_review' THEN 'pending_review'
    WHEN status = 'rejected'       THEN 'rejected'
    WHEN status = 'draft'          THEN 'draft'
    WHEN status = 'archived'       THEN 'unpublished'
    ELSE 'published'
  END WHERE TRUE;
END $backfill$;

CREATE INDEX IF NOT EXISTS sr_items_publish_state_live
  ON public.sr_items(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.sr_items_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT i.title::text,
         NULLIF(i.subtitle, '')::text,
         i.featured_image_url::text
  FROM public.sr_items i WHERE i.id = p_id;
$$;
ALTER FUNCTION public.sr_items_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[structured-resources/003] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'sr_item',
    p_table_name        => 'public.sr_items'::regclass,
    p_display_label     => 'Structured Resource Item',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.sr_items_inbox_preview(uuid)'::regprocedure
  );
END $register$;
