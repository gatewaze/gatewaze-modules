-- ============================================================================
-- Module: events
-- Migration: 016_luma_outbound_sync
-- Description: Outbound Luma sync state. The existing luma_* columns track the
--              INBOUND direction (scraping Luma → Gatewaze). These columns track
--              the OUTBOUND direction (pushing Gatewaze edits → Luma) used by the
--              luma-event-sync agent.
--
--              Loop-prevention: luma_pushed_hash records the field values the
--              agent last pushed to Luma, so a later inbound scrape of our own
--              edit is not mistaken for a fresh divergence.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS luma_sync_status text
    CHECK (luma_sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  ADD COLUMN IF NOT EXISTS luma_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS luma_sync_error text,
  ADD COLUMN IF NOT EXISTS luma_pushed_hash text;

COMMENT ON COLUMN public.events.luma_sync_status IS
  'Outbound push state to Luma: pending (changed, awaiting push), syncing '
  '(push in progress), synced (push verified), failed (see luma_sync_error). '
  'NULL means never considered for outbound sync. Distinct from '
  'luma_processing_status, which is the inbound scrape pipeline.';

COMMENT ON COLUMN public.events.luma_synced_at IS
  'Timestamp of the last successful outbound push of this event to Luma.';

COMMENT ON COLUMN public.events.luma_sync_error IS
  'Error detail from the most recent failed outbound push, else NULL.';

COMMENT ON COLUMN public.events.luma_pushed_hash IS
  'Hash of the field values the luma-event-sync agent last pushed to Luma. '
  'Loop-prevention: when the inbound scraper later reads the Luma page, a '
  'matching hash means the "change" is our own echo and should not be treated '
  'as an inbound divergence.';

-- Partial index for the agent's candidate query: events that have a Luma
-- counterpart and are awaiting or eligible for an outbound push.
CREATE INDEX IF NOT EXISTS idx_events_luma_sync_pending
  ON public.events (luma_synced_at)
  WHERE luma_event_id IS NOT NULL;
