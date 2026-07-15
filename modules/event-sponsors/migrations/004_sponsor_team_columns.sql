-- ============================================================================
-- Module: event-sponsors
-- Migration: 004_sponsor_team_columns
-- Description: Schema for sponsor TEAM management, which the admin UI (Manage
-- Team modal, check-in badge scanning) has written to since day one but which
-- was never created by any migration: events_registrations.sponsor_team_id +
-- is_primary_contact, the 'sponsor_staff' registration_type the assign path
-- writes, and the events_registrations_with_people view refresh so the new
-- columns surface to the admin (the view is SELECT r.* — frozen at creation).
-- ============================================================================

ALTER TABLE public.events_registrations
  ADD COLUMN IF NOT EXISTS sponsor_team_id uuid REFERENCES public.events_sponsors(id) ON DELETE SET NULL;
ALTER TABLE public.events_registrations
  ADD COLUMN IF NOT EXISTS is_primary_contact boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.events_registrations.sponsor_team_id IS
  'Event-sponsor (events_sponsors.id) whose team this registration belongs to — team members scan badges in the check-in app.';
COMMENT ON COLUMN public.events_registrations.is_primary_contact IS
  'This registration is the sponsor team''s primary contact (at most one per team, enforced by the admin service).';

CREATE INDEX IF NOT EXISTS idx_events_registrations_sponsor_team
  ON public.events_registrations (sponsor_team_id) WHERE sponsor_team_id IS NOT NULL;

-- The team-assign path sets registration_type='sponsor_staff', which the
-- original CHECK (free/paid/comp/sponsor/speaker/staff/vip) rejects.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.events_registrations'::regclass
    AND conname = 'events_registrations_registration_type_check';
  IF v_def IS NOT NULL AND v_def NOT LIKE '%sponsor_staff%' THEN
    ALTER TABLE public.events_registrations
      DROP CONSTRAINT events_registrations_registration_type_check;
    ALTER TABLE public.events_registrations
      ADD CONSTRAINT events_registrations_registration_type_check
      CHECK (registration_type = ANY (ARRAY[
        'free'::text, 'paid'::text, 'comp'::text, 'sponsor'::text,
        'sponsor_staff'::text, 'speaker'::text, 'staff'::text, 'vip'::text
      ]));
  END IF;
END $$;

-- Refresh the registrations+people view: it was created as SELECT r.* so its
-- column list is frozen at creation time — the new columns need a re-create
-- (DROP, not OR REPLACE: the r.* expansion inserts columns mid-list).
DROP VIEW IF EXISTS public.events_registrations_with_people;
CREATE VIEW public.events_registrations_with_people AS
SELECT
  r.*,
  p.email,
  p.attributes->>'first_name'   AS first_name,
  p.attributes->>'last_name'    AS last_name,
  COALESCE(
    NULLIF(TRIM(COALESCE(p.attributes->>'first_name', '') || ' ' || COALESCE(p.attributes->>'last_name', '')), ''),
    p.attributes->>'first_name'
  ) AS full_name,
  p.attributes->>'company'      AS company,
  p.attributes->>'job_title'    AS job_title,
  p.attributes->>'linkedin_url' AS linkedin_url,
  p.avatar_url,
  p.phone,
  p.attributes->>'location'     AS location,
  p.cio_id,
  p.attributes AS people_attributes
FROM public.events_registrations r
LEFT JOIN public.people p ON p.id = r.person_id;
