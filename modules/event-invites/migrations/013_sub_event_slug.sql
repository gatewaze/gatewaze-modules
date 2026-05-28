-- ============================================================================
-- Module: event-invites
-- Migration: 013_sub_event_slug
-- Description: Add a per-event slug on invite_sub_events so the CSV
--              importer can match a column value (e.g. "day", "evening")
--              to the right sub-event without relying on the display
--              name. Previously the importer prefix-matched sub-event
--              names, which silently failed for names like "The full
--              deal (ceremony, meal and evening)" and fell through to
--              "assign to every sub-event".
-- ============================================================================

ALTER TABLE public.invite_sub_events
  ADD COLUMN IF NOT EXISTS slug text;

-- Unique per event. Null slugs are allowed (and the index ignores them)
-- so existing sub-events don't need to be renamed immediately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_sub_events_event_slug
  ON public.invite_sub_events(event_id, slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.invite_sub_events.slug IS
  'Optional short identifier (e.g. "day", "evening"). Used to match a CSV '
  'import column value to this sub-event. Unique per event. Prefer this '
  'over name-based matching.';
