-- ============================================================================
-- Module: lists
-- Migration: 002_event_updates_list
-- Description: Seed the well-known global "Event Updates" list. Event Comms
-- sends (the events module's Comms tab) target this list, so every event email
-- is tied to a real list subscription and recipients can unsubscribe from event
-- updates as a category (per the unified email-sending model — list-tied sends +
-- per-list unsubscribe). Idempotent; referenced by the stable slug 'event-updates'.
-- ============================================================================

INSERT INTO public.lists (id, slug, name, description, is_active, is_public, default_subscribed)
VALUES (
  'e7e70000-0000-0000-0000-000000000001',
  'event-updates',
  'Event Updates',
  'Updates and announcements about events (e.g. reminders, schedule changes, follow-ups).',
  true,
  true,
  false
)
ON CONFLICT (slug) DO NOTHING;
