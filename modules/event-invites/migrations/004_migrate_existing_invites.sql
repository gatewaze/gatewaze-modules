-- ============================================================================
-- Module: event-invites
-- Migration: 004_migrate_existing_invites
-- Description: Migrate data from legacy event_invites table to the new
--              party-based model. Each invite becomes a single-person party.
--              Renames old table to event_invites_legacy.
-- ============================================================================

-- Generate a random 8-char base62 short code
CREATE OR REPLACE FUNCTION public._generate_short_code() RETURNS text AS $$
DECLARE
  chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(chars, floor(random() * 62 + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Migrate each event_invite row into the party model
-- Skip if legacy table already exists (migration already ran) or source table doesn't exist
DO $$
DECLARE
  inv RECORD;
  new_party_id uuid;
  new_member_id uuid;
  short text;
  rsvp text;
BEGIN
  -- Skip if event_invites doesn't exist (fresh install with no legacy data)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'event_invites'
  ) THEN
    RAISE NOTICE 'No event_invites table found — skipping data migration';
    RETURN;
  END IF;

  FOR inv IN SELECT * FROM public.event_invites LOOP
    -- Generate unique short code
    LOOP
      short := public._generate_short_code();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invite_parties WHERE short_code = short);
    END LOOP;

    -- Map old status to party status
    -- Old statuses: pending, sent, opened, accepted, declined, expired, cancelled
    -- New party statuses: draft, sent, opened, partially_responded, responded, expired, cancelled

    -- Map old rsvp_response to new rsvp_status
    IF inv.rsvp_response = 'yes' THEN rsvp := 'accepted';
    ELSIF inv.rsvp_response = 'no' THEN rsvp := 'declined';
    ELSIF inv.rsvp_response = 'maybe' THEN rsvp := 'maybe';
    ELSE rsvp := 'pending';
    END IF;

    -- Create party
    INSERT INTO public.invite_parties (
      id, name, token, short_code, status, delivery_channel,
      sent_at, opened_at,
      responded_at, batch_id, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      COALESCE(NULLIF(TRIM(COALESCE(inv.first_name, '') || ' ' || COALESCE(inv.last_name, '')), ''), inv.email),
      inv.token,
      short,
      CASE inv.status
        WHEN 'pending' THEN 'draft'
        WHEN 'sent' THEN 'sent'
        WHEN 'opened' THEN 'opened'
        WHEN 'accepted' THEN 'responded'
        WHEN 'declined' THEN 'responded'
        WHEN 'expired' THEN 'expired'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'draft'
      END,
      'email',
      inv.sent_at,
      inv.opened_at,
      inv.rsvp_responded_at,
      inv.batch_id,
      inv.created_at,
      inv.updated_at
    ) RETURNING id INTO new_party_id;

    -- Create party member (lead booker)
    INSERT INTO public.invite_party_members (
      id, party_id, person_id, first_name, last_name, email,
      is_lead_booker, sort_order, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      new_party_id,
      inv.people_profile_id,  -- may be null
      inv.first_name,
      inv.last_name,
      inv.email,
      true,
      0,
      inv.created_at,
      inv.updated_at
    ) RETURNING id INTO new_member_id;

    -- Create member-event mapping
    INSERT INTO public.invite_party_member_events (
      party_member_id, event_id, rsvp_status, rsvp_responded_at,
      registration_id, created_at, updated_at
    ) VALUES (
      new_member_id,
      inv.event_id,
      rsvp,
      inv.rsvp_responded_at,
      inv.registration_id,
      inv.created_at,
      inv.updated_at
    );
  END LOOP;
END $$;

-- Drop the short code generator function (one-time use)
DROP FUNCTION IF EXISTS public._generate_short_code();

-- Rename legacy table (keep for 30 days) — skip if already renamed or doesn't exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'event_invites'
  ) THEN
    ALTER TABLE public.event_invites RENAME TO event_invites_legacy;
  END IF;
END $$;

-- Drop old view if it exists
DROP VIEW IF EXISTS public.event_invites_with_details;
