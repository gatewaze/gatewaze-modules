-- ============================================================================
-- Module: event-invites
-- Migration: 012_event_rsvp_deadline
-- Description: Add an RSVP deadline on the main event record so organisers
--              running a single-track event (no sub-events) can still cap
--              when responses are accepted. Sub-events already have their
--              own invite_sub_events.rsvp_deadline for per-track cutoffs;
--              this is the analogue for the parent event.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS rsvp_deadline timestamptz;

COMMENT ON COLUMN public.events.rsvp_deadline IS
  'Optional cutoff after which new open-RSVP submissions are rejected. '
  'Null = no deadline. Use invite_sub_events.rsvp_deadline for per-sub-event deadlines.';
