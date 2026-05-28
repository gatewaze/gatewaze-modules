-- ============================================================================
-- event_hosts: track when we last scanned a host's profile for their events.
-- Lets the LumaHostEnricher rotate through hosts to keep their event list
-- fresh, separately from the enrichment_tried_at backlog rotation.
-- ============================================================================
ALTER TABLE public.event_hosts
  ADD COLUMN IF NOT EXISTS events_scanned_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_event_hosts_events_scanned_at
  ON public.event_hosts (events_scanned_at NULLS FIRST)
  WHERE luma_profile_url IS NOT NULL AND is_company = false;

COMMENT ON COLUMN public.event_hosts.events_scanned_at IS
  'Last time LumaHostEnricher walked this host''s profile to pull their events list. NULL = never scanned. Backlog-first rotation, then oldest-first like enrichment_tried_at.';
