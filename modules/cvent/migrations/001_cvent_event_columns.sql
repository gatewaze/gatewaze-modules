-- Add Cvent integration columns to events table
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cvent_event_id TEXT,
  ADD COLUMN IF NOT EXISTS cvent_event_code TEXT,
  ADD COLUMN IF NOT EXISTS cvent_admission_item_id TEXT,
  ADD COLUMN IF NOT EXISTS cvent_sync_enabled BOOLEAN NOT NULL DEFAULT false;

-- Index for quick lookup of events with Cvent sync enabled
CREATE INDEX IF NOT EXISTS idx_events_cvent_event_id ON events(cvent_event_id) WHERE cvent_event_id IS NOT NULL;
