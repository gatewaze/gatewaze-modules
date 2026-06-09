-- ============================================================================
-- event-sponsors — register event_sponsor with content-platform.
-- ============================================================================

ALTER TABLE public.events_sponsors
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  -- events_sponsors uses status='complete' default + 002_triage_adapter added
  -- pending_review/rejected. Map complete → published.
  --
  -- The status column is only present when the content-triage module was
  -- installed BEFORE event-sponsors. If it wasn't, 002 silently no-op'd
  -- and we have no `status` to map from — every row stays with its
  -- DEFAULT publish_state='published', which is the correct fallback for
  -- pre-triage data.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='events_sponsors' AND column_name='status'
  ) THEN
    UPDATE public.events_sponsors SET publish_state = CASE
      WHEN status = 'pending_review' THEN 'pending_review'
      WHEN status = 'rejected'       THEN 'rejected'
      WHEN status = 'incomplete'     THEN 'draft'
      ELSE 'published'  -- complete + anything else
    END
    WHERE status IS NOT NULL;
  END IF;
  -- Items where is_active=false should be unpublished.
  UPDATE public.events_sponsors SET publish_state = 'unpublished'
    WHERE is_active = false AND publish_state = 'published';
END $backfill$;

CREATE INDEX IF NOT EXISTS events_sponsors_publish_state_live
  ON public.events_sponsors(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.event_sponsors_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT
    COALESCE(esp.name, es.sponsor_name, 'Unknown sponsor')::text,
    NULLIF(concat_ws(' · ',
      NULLIF(es.tier, ''),
      NULLIF(es.sponsorship_tier, '')
    ), '')::text,
    COALESCE(esp.logo_url, es.sponsor_logo_url)::text
  FROM public.events_sponsors es
  LEFT JOIN public.events_sponsor_profiles esp ON esp.id = es.sponsor_id
  WHERE es.id = p_id;
$$;
ALTER FUNCTION public.event_sponsors_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

-- register_content_type() is SECURITY DEFINER and (depending on which role
-- owns it after content-platform's own migrations) runs its internal
-- `GRANT SELECT, UPDATE(publish_state) ON events_sponsors TO
-- gatewaze_module_writer` as gatewaze_module_writer. That role neither owns
-- this table (supabase_admin does) nor holds the privilege WITH GRANT OPTION,
-- so the internal grant trips 42501. This migration runs as the table owner,
-- so pre-grant the privileges WITH GRANT OPTION here; the internal re-grant
-- then succeeds regardless of register_content_type's owner. (Sibling
-- event-speakers/006 only avoided this by lucky reconcile ordering.)
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    GRANT SELECT, UPDATE ON public.events_sponsors TO gatewaze_module_writer WITH GRANT OPTION;
  END IF;
END $grant$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[event-sponsors/003] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'event_sponsor',
    p_table_name        => 'public.events_sponsors'::regclass,
    p_display_label     => 'Event Sponsor',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.event_sponsors_inbox_preview(uuid)'::regprocedure
  );
END $register$;
