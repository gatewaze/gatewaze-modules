-- ============================================================================
-- Module: calendars
-- Migration: 016_luma_sync_enabled
-- Description: Per-calendar opt-in for outbound Luma sync. The luma-event-sync
--              agent only pushes Gatewaze edits to Luma for events that belong
--              to a calendar with luma_sync_enabled = true. This is the
--              ownership gate: calendars we scraped from third parties stay
--              false, so the agent never edits events we do not own.
--
--              Resolution path: events.id → calendars_events.event_id →
--              calendars.id, then check calendars.luma_sync_enabled and use
--              calendars.luma_calendar_id as the target Luma calendar.
-- ============================================================================

ALTER TABLE public.calendars
  ADD COLUMN IF NOT EXISTS luma_sync_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.calendars.luma_sync_enabled IS
  'When true, the luma-event-sync agent is allowed to push Gatewaze event '
  'edits out to the matching Luma events on this calendar. Default false — '
  'scraped third-party calendars must stay false so we never edit events we '
  'do not own. Requires luma_calendar_id to be set to identify the target.';

-- Speeds up the agent''s "which calendars are syncable" lookup.
CREATE INDEX IF NOT EXISTS idx_calendars_luma_sync_enabled
  ON public.calendars (id)
  WHERE luma_sync_enabled = true;
