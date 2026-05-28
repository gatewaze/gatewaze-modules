-- ============================================================================
-- Module: event-invites
-- Migration: 006_linked_rsvp
-- Description: Add linked_rsvp flag to invite_sub_events. When true,
--              accepting one sub-event auto-accepts all other linked
--              sub-events for the same member. Use for weddings where
--              day attendance implies evening attendance.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invite_sub_events' AND column_name = 'linked_rsvp'
  ) THEN
    ALTER TABLE public.invite_sub_events
      ADD COLUMN linked_rsvp boolean DEFAULT false;
  END IF;
END $$;
