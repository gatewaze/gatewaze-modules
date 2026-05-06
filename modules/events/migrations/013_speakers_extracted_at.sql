-- ============================================================================
-- Module: events
-- Migration: 013_speakers_extracted_at
-- Description: Track per-event "speaker extraction has run" state so the
--              scraper pipeline can defer the (slow + paid) Anthropic call
--              into a separate bulk job. NULL = not yet processed.
--              Spec: spec-scrapling-fetcher-service.md follow-up §15.6.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS speakers_extracted_at timestamptz;

COMMENT ON COLUMN public.events.speakers_extracted_at IS
  'When the scraper:speaker-extract bulk job last ran for this event. '
  'NULL means the event has been scraped but speakers have not yet been '
  'extracted; admin UI can show a "speakers pending" badge on these.';

-- Partial index — only events still pending. Keeps the index tiny and
-- the cron / batch picker fast even on million-row tables.
CREATE INDEX IF NOT EXISTS idx_events_speakers_pending
  ON public.events (created_at)
  WHERE speakers_extracted_at IS NULL;
