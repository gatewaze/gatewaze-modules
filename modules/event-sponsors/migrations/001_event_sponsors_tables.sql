-- ============================================================================
-- Module: event-sponsors
-- Migration: 001_event_sponsors_tables
-- Description: Sponsor profiles and event-sponsor junction tables.
-- ============================================================================

-- ==========================================================================
-- 1. events_sponsor_profiles
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_sponsor_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text UNIQUE,
  logo_url      text,
  website       text,
  description   text,
  contact_email text,
  contact_phone text,
  social_links  jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER events_sponsor_profiles_updated_at
  BEFORE UPDATE ON public.events_sponsor_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_sponsors (junction: events to sponsor profiles)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_sponsors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  sponsor_id        uuid NOT NULL REFERENCES public.events_sponsor_profiles(id) ON DELETE CASCADE,
  sponsor_name      text,
  sponsor_logo_url  text,
  tier              text,
  sponsorship_tier  text CHECK (sponsorship_tier IN ('platinum', 'gold', 'silver', 'bronze', 'partner', 'exhibitor')),
  booth_number      text,
  booth_size        text,
  benefits          jsonb,
  custom_branding   jsonb,
  sponsor_profile_id uuid REFERENCES public.events_sponsor_profiles(id) ON DELETE SET NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, sponsor_id)
);

CREATE INDEX IF NOT EXISTS idx_events_sponsors_event ON public.events_sponsors (event_id);
CREATE INDEX IF NOT EXISTS idx_events_sponsors_sponsor ON public.events_sponsors (sponsor_id);

CREATE TRIGGER events_sponsors_updated_at
  BEFORE UPDATE ON public.events_sponsors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. Conditional FKs: link core tables to sponsors if they exist
-- ==========================================================================

-- events_contact_scans.event_sponsor_id → events_sponsors
-- (requires badge-scanning module to be installed first)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_contact_scans') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_contact_scans_event_sponsor_id_fkey') THEN
      ALTER TABLE public.events_contact_scans
        ADD CONSTRAINT events_contact_scans_event_sponsor_id_fkey
        FOREIGN KEY (event_sponsor_id) REFERENCES public.events_sponsors(id);
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 4. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_sponsor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_sponsors ENABLE ROW LEVEL SECURITY;

-- Sponsor profiles (global, public read)
CREATE POLICY "sponsors_select"
  ON public.events_sponsor_profiles FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "sponsors_insert"
  ON public.events_sponsor_profiles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "sponsors_update"
  ON public.events_sponsor_profiles FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "sponsors_delete"
  ON public.events_sponsor_profiles FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- Event sponsors junction (public read)
CREATE POLICY "event_sponsors_select_anon"
  ON public.events_sponsors FOR SELECT TO anon
  USING (true);

CREATE POLICY "event_sponsors_select_auth"
  ON public.events_sponsors FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "event_sponsors_insert"
  ON public.events_sponsors FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "event_sponsors_update"
  ON public.events_sponsors FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "event_sponsors_delete"
  ON public.events_sponsors FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));
