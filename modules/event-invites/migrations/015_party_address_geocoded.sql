-- =============================================================================
-- Module: event-invites
-- Migration: 015_party_address_geocoded
-- Description: Cache geocoded coordinates + driving route from each invite
--              party's mailing address to the parent event's venue. Populated
--              lazily by the send flow (event-invite-admin edge function) the
--              first time an invite is dispatched for a party — re-used on
--              subsequent sends so the geocoder + OSRM aren't hammered for
--              every reminder.
--
-- Why cache:
--   - Nominatim asks for ≤1 req/sec and we send invites in bulk (50–200 at a
--     time for a typical wedding/event).
--   - OSRM's driving-route call is cheap but still adds latency to each send.
--   - The address rarely changes; when it does, the admin form clears the
--     cache (handled at the application layer) so the next send re-geocodes.
--
-- Used to populate template variables `{distance_to_venue}` +
-- `{drive_time_to_venue}` in the invite email/SMS/WhatsApp templates.
-- =============================================================================

ALTER TABLE public.invite_parties
  ADD COLUMN IF NOT EXISTS address_lat double precision,
  ADD COLUMN IF NOT EXISTS address_lng double precision,
  ADD COLUMN IF NOT EXISTS address_geocoded_at timestamptz,
  ADD COLUMN IF NOT EXISTS drive_seconds_to_venue integer,
  ADD COLUMN IF NOT EXISTS drive_distance_meters_to_venue integer,
  ADD COLUMN IF NOT EXISTS drive_route_computed_at timestamptz;

COMMENT ON COLUMN public.invite_parties.address_lat IS
  'Geocoded latitude of address (Nominatim). NULL until first send computes it. Cleared by the admin when address changes.';
COMMENT ON COLUMN public.invite_parties.address_lng IS
  'Geocoded longitude of address. See address_lat.';
COMMENT ON COLUMN public.invite_parties.address_geocoded_at IS
  'When the address was last geocoded. Used to invalidate stale lookups.';
COMMENT ON COLUMN public.invite_parties.drive_seconds_to_venue IS
  'OSRM driving duration from address to event venue, in seconds. NULL when route lookup failed or coordinates missing.';
COMMENT ON COLUMN public.invite_parties.drive_distance_meters_to_venue IS
  'OSRM driving distance from address to event venue, in metres.';
COMMENT ON COLUMN public.invite_parties.drive_route_computed_at IS
  'When the route was last computed. Re-runs when address changes, or when the venue lat/lng changes (driven at the application layer).';

-- Trigger: when address column changes, clear the geocode cache so the next
-- send picks up a fresh lookup. Cheap to re-geocode (one row), expensive to
-- silently send a stale distance that's wrong by 200 miles.
CREATE OR REPLACE FUNCTION public.trg_invite_parties_clear_geocode_on_address_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.address IS DISTINCT FROM OLD.address THEN
    NEW.address_lat := NULL;
    NEW.address_lng := NULL;
    NEW.address_geocoded_at := NULL;
    NEW.drive_seconds_to_venue := NULL;
    NEW.drive_distance_meters_to_venue := NULL;
    NEW.drive_route_computed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invite_parties_clear_geocode_on_address_change ON public.invite_parties;
CREATE TRIGGER trg_invite_parties_clear_geocode_on_address_change
  BEFORE UPDATE OF address ON public.invite_parties
  FOR EACH ROW EXECUTE FUNCTION public.trg_invite_parties_clear_geocode_on_address_change();
