-- ============================================================================
-- Module: bulk-emailing
-- Migration: 007_newsletter_link_tracking
-- Description: Resolution columns on email_interactions for newsletter
--              block-level click tracking (spec-newsletter-link-tracking.md
--              §4.4 / §5.2). The email-webhook parses the ?nlb= tracking key
--              from clicked_url and writes the resolved block/edition here at
--              ingest time, so reporting is a simple join.
-- ============================================================================

ALTER TABLE public.email_interactions
  -- Logical FK to public.newsletters_edition_links(id). Not declared as a SQL
  -- FK to avoid a hard cross-module dependency on the newsletters module
  -- (email_interactions must exist even when newsletters isn't installed).
  ADD COLUMN IF NOT EXISTS edition_link_id uuid,
  ADD COLUMN IF NOT EXISTS block_id        uuid,   -- denormalised for fast rollups
  ADD COLUMN IF NOT EXISTS block_type      text,
  ADD COLUMN IF NOT EXISTS edition_id      uuid,
  -- Personalization consent captured AT INGEST (spec §7). Opt-in model:
  -- default false = consent NOT given. The row still counts toward aggregate
  -- block/edition metrics, but is NEVER attributed to the individual.
  -- Per-persona reporting only includes rows where this is true.
  ADD COLUMN IF NOT EXISTS personalization_consent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ei_edition_link
  ON public.email_interactions (edition_link_id)
  WHERE edition_link_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ei_block_type
  ON public.email_interactions (block_type, event_timestamp DESC)
  WHERE block_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ei_edition
  ON public.email_interactions (edition_id, event_timestamp DESC)
  WHERE edition_id IS NOT NULL;

COMMENT ON COLUMN public.email_interactions.edition_link_id IS
  'Resolved newsletters_edition_links.id (from the ?nlb= key in clicked_url). NULL for opens, non-newsletter mail, and clicks on untracked/legacy links.';
