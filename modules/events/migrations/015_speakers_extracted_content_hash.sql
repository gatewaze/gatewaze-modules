-- ============================================================================
-- Module: events
-- Migration: 015_speakers_extracted_content_hash
-- Description: Track the SHA-256 of the input HTML the speaker-extract bulk
--              job last ran against. When a daily re-scrape produces the same
--              hash, the worker skips the Anthropic call entirely — typical
--              steady-state savings ~90 % of LLM spend on rescrapes.
--              See spec-scrapling-fetcher-service.md follow-up §15.6.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS speakers_extracted_content_hash text;

COMMENT ON COLUMN public.events.speakers_extracted_content_hash IS
  'SHA-256 hex digest of the description-HTML that was fed to '
  'extractSpeakersFromHtml on the most recent run. The worker compares '
  'the new hash to this column and skips the Anthropic call when they '
  'match. NULL means "never extracted" or "extracted before this column '
  'existed" — first run after column add re-extracts once then stores '
  'the hash.';
