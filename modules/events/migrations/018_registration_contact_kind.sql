-- ============================================================================
-- Module: events
-- Migration: 018_registration_contact_kind
-- Description: Registering for an event converts an outreach prospect
-- (people.contact_kind='prospect' — legitimate-interest contact, no opt-in)
-- into an 'event_contact' (contract basis: event/transactional email is fine).
-- Counterpart of core migration 00042 (which owns the contact_kind column and
-- the auth-link → 'member' conversion). Kinds never downgrade.
-- ============================================================================

-- Guard for installs where the core contact_kind migration hasn't run yet
-- (identical idempotent ADD; the CHECK + comments live with core 00042).
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS contact_kind text NOT NULL DEFAULT 'member';

CREATE OR REPLACE FUNCTION public.events_registration_contact_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.people
  SET contact_kind = 'event_contact'
  WHERE id = NEW.person_id
    AND contact_kind = 'prospect';
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS events_registration_contact_kind ON public.events_registrations;
CREATE TRIGGER events_registration_contact_kind
  AFTER INSERT ON public.events_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.events_registration_contact_kind();
