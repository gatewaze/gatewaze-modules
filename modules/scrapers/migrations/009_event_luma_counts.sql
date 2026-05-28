-- Track Luma attendance signals on the event itself. Updated on every scrape
-- so we always reflect the live state of the event on Luma. Enables the
-- Registrations tab to display crowd size before we have per-attendee data,
-- and feeds the host leaderboard with weighted-guest scores.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS luma_guest_count INTEGER,
  ADD COLUMN IF NOT EXISTS luma_ticket_count INTEGER,
  ADD COLUMN IF NOT EXISTS luma_counts_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_luma_guest_count
  ON events (luma_guest_count DESC NULLS LAST)
  WHERE luma_guest_count IS NOT NULL;

-- Host-level signals: position in the Luma hosts[] array (1 = primary) and
-- the event's guest_count at the time we linked this host. Denormalising
-- guest_count here avoids a 3-table join in the leaderboard hot path.

ALTER TABLE event_host_events
  ADD COLUMN IF NOT EXISTS host_position INTEGER,
  ADD COLUMN IF NOT EXISTS guest_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_event_host_events_position
  ON event_host_events (host_position)
  WHERE host_position IS NOT NULL;
