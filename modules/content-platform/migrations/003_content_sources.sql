-- ============================================================================
-- content-platform — content source tracking ("how did this content arrive?")
-- See spec-unified-content-management.md §5.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.content_sources (
  content_type text NOT NULL,
  content_id   uuid NOT NULL,
  source_kind  text NOT NULL CHECK (source_kind IN
    ('admin_ui','api','mcp','scraper','ai_discovery','user_submission','import','unknown')),
  source_ref   text,
  source_meta  jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_type, content_id)
);
CREATE INDEX IF NOT EXISTS content_sources_kind ON public.content_sources (source_kind, recorded_at DESC);
ALTER TABLE public.content_sources OWNER TO gatewaze_module_writer;

-- ----------------------------------------------------------------------------
-- record_content_source — idempotent UPSERT. Caller-side: scraper handler,
-- admin UI insert path, API/MCP wrappers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_content_source(
  p_content_type text,
  p_content_id   uuid,
  p_source_kind  text,
  p_source_ref   text DEFAULT NULL,
  p_source_meta  jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  INSERT INTO public.content_sources
    (content_type, content_id, source_kind, source_ref, source_meta)
  VALUES (p_content_type, p_content_id, p_source_kind, p_source_ref, p_source_meta)
  ON CONFLICT (content_type, content_id) DO UPDATE SET
    source_kind = EXCLUDED.source_kind,
    source_ref  = EXCLUDED.source_ref,
    source_meta = EXCLUDED.source_meta,
    recorded_at = now();
$$;
ALTER FUNCTION public.record_content_source(text, uuid, text, text, jsonb) OWNER TO gatewaze_module_writer;
GRANT EXECUTE ON FUNCTION public.record_content_source(text, uuid, text, text, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- Backfill events.source_type into content_sources where the events table
-- already has it. Soft-guarded.
-- ----------------------------------------------------------------------------
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='events' AND column_name='source_type'
  ) THEN
    INSERT INTO public.content_sources (content_type, content_id, source_kind, source_ref, source_meta)
    SELECT 'event', e.id,
           CASE e.source_type
             WHEN 'manual' THEN 'admin_ui'
             WHEN 'scraper' THEN 'scraper'
             WHEN 'user_submission' THEN 'user_submission'
             ELSE 'unknown'
           END,
           e.scraped_by,
           COALESCE(e.source_details, '{}'::jsonb)
    FROM public.events e
    ON CONFLICT (content_type, content_id) DO NOTHING;
  END IF;
END $backfill$;
