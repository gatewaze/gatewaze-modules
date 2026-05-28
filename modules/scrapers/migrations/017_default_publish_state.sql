-- ============================================================================
-- scrapers module — default_publish_state
-- Replaces the existing triage_mode column with a clearer per-scraper switch
-- that controls the initial publish_state of newly-scraped events.
--
-- See spec-content-publishing-pipeline.md §5.2.
-- ============================================================================

ALTER TABLE public.scrapers
  ADD COLUMN IF NOT EXISTS default_publish_state text NOT NULL DEFAULT 'pending_review'
  CHECK (default_publish_state IN ('pending_review','published'));

-- Backfill from existing triage_mode:
--   triage_mode = 'auto_publish' or NULL -> 'published' (preserves legacy behaviour)
--   triage_mode IN ('review', 'auto_approve') -> 'pending_review'
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='scrapers' AND column_name='triage_mode'
  ) THEN
    UPDATE public.scrapers SET default_publish_state = 'published'
      WHERE triage_mode = 'auto_publish' OR triage_mode IS NULL;
    UPDATE public.scrapers SET default_publish_state = 'pending_review'
      WHERE triage_mode IN ('review','auto_approve');
    COMMENT ON COLUMN public.scrapers.triage_mode IS
      'DEPRECATED — superseded by default_publish_state. To be dropped in next release.';
  END IF;
END $backfill$;

COMMENT ON COLUMN public.scrapers.default_publish_state IS
  'Initial publish_state for events created by this scraper. ''pending_review'' = gated by content-triage; ''published'' = visible immediately.';
