-- ============================================================================
-- event-speakers — register event_speaker with content-platform.
-- ============================================================================

ALTER TABLE public.events_speakers
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  -- events_speakers.status defaults to 'confirmed'; 005_triage_adapter added
  -- pending_review/rejected. Map confirmed → published; pending_review/rejected
  -- pass through.
  UPDATE public.events_speakers SET publish_state = CASE
    WHEN status = 'pending_review' THEN 'pending_review'
    WHEN status = 'rejected'       THEN 'rejected'
    WHEN status = 'declined'       THEN 'unpublished'
    WHEN status = 'cancelled'      THEN 'unpublished'
    WHEN status = 'invited'        THEN 'pending_review'
    ELSE 'published'  -- confirmed, accepted, anything else
  END WHERE TRUE;
END $backfill$;

CREATE INDEX IF NOT EXISTS events_speakers_publish_state_live
  ON public.events_speakers(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.event_speakers_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT
    COALESCE(esp.name, 'Unknown speaker')::text,
    NULLIF(concat_ws(' · ',
      NULLIF(esp.title, ''),
      NULLIF(esp.company, ''),
      NULLIF(es.role, '')
    ), '')::text,
    esp.avatar_url::text
  FROM public.events_speakers es
  LEFT JOIN public.events_speaker_profiles esp ON esp.id = es.speaker_id
  WHERE es.id = p_id;
$$;
ALTER FUNCTION public.event_speakers_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[event-speakers/006] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'event_speaker',
    p_table_name        => 'public.events_speakers'::regclass,
    p_display_label     => 'Event Speaker',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.event_speakers_inbox_preview(uuid)'::regprocedure
  );
END $register$;
