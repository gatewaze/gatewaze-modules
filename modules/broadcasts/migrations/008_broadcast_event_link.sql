-- ============================================================================
-- Module: broadcasts
-- Migration: 008_broadcast_event_link
-- Description: Optionally link a broadcast to an event. This powers
-- Call-for-Speakers (CFP) / event-promotion sends: the audience is a SEGMENT of
-- the whole contact database (e.g. "AI engineers near Berlin"), while the linked
-- event provides {{event_*}} merge variables + the submit-talk URL injected into
-- the content at send-creation. Event-relational audiences (registrants /
-- attendees / speakers-by-status) stay in the events Comms tab; reaching OUT to
-- the database to recruit is a broadcast. event_id is nullable (most broadcasts
-- are not event-linked) and SET NULL on event delete (the send keeps its baked
-- content).
-- ============================================================================

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

ALTER TABLE public.broadcast_sends
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.broadcasts.event_id IS
  'Optional linked event. When set, the content editor offers {{event_*}} variables (name/date/city/url/cfp_url) baked into each send at creation. Audience is still the broadcast segment/lists, not the event''s relational audiences.';
COMMENT ON COLUMN public.broadcast_sends.event_id IS
  'Snapshot of the parent broadcast''s linked event at send time (for reporting / re-render).';
