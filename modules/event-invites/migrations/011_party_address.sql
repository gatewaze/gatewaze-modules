-- ============================================================================
-- Module: event-invites
-- Migration: 011_party_address
-- Description: Adds a postal address field to invite_parties for envelope
--              printing. One address per party (the mailing destination).
--              Also updates the invite_parties_with_stats view to expose it.
-- ============================================================================

ALTER TABLE public.invite_parties
  ADD COLUMN IF NOT EXISTS address text;

COMMENT ON COLUMN public.invite_parties.address IS
  'Postal address for this party — used when generating envelope PDFs for printed invites.';

-- Recreate the stats view with the new address column
DROP VIEW IF EXISTS public.invite_parties_with_stats;
CREATE VIEW public.invite_parties_with_stats AS
SELECT
  p.id,
  p.name,
  p.token,
  p.short_code,
  p.max_plus_ones,
  p.plus_ones_added,
  p.status,
  p.delivery_channel,
  p.sent_at,
  p.opened_at,
  p.responded_at,
  p.notes,
  p.batch_id,
  p.version,
  p.created_at,
  p.updated_at,
  p.address,
  COUNT(DISTINCT pm.id) AS member_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'accepted') AS accepted_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'declined') AS declined_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'pending') AS pending_count,
  lb.first_name AS lead_first_name,
  lb.last_name AS lead_last_name,
  lb.email AS lead_email,
  ARRAY_AGG(DISTINCT pme.event_id) FILTER (WHERE pme.event_id IS NOT NULL) AS event_ids
FROM invite_parties p
LEFT JOIN invite_party_members pm ON pm.party_id = p.id
LEFT JOIN invite_party_member_events pme ON pme.party_member_id = pm.id
LEFT JOIN invite_party_members lb ON lb.party_id = p.id AND lb.is_lead_booker = true
GROUP BY p.id, lb.first_name, lb.last_name, lb.email;
