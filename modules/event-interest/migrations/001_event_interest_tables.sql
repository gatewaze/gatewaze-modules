-- ============================================================================
-- Module: event-interest
-- Migration: 001_event_interest_tables
-- Description: Tables for capturing expressions of interest in events
--              before registration opens.
-- ============================================================================

-- ==========================================================================
-- 1. events_interest
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_interest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  last_name text,
  company text,
  job_title text,
  phone text,
  linkedin_url text,
  interest_source text,
  interest_type text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'converted', 'withdrawn')),
  source text,
  expressed_at timestamptz DEFAULT now(),
  people_profile_id uuid,
  person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  converted_to_registration_id uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_interest_event ON public.events_interest (event_id);
CREATE INDEX IF NOT EXISTS idx_events_interest_email ON public.events_interest (email);

CREATE TRIGGER events_interest_updated_at
  BEFORE UPDATE ON public.events_interest
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_interest_with_details - View joining interest with people names
-- ==========================================================================
CREATE OR REPLACE VIEW public.events_interest_with_details AS
SELECT ei.*,
  c.full_name AS display_first_name,
  NULL::text AS display_last_name
FROM public.events_interest ei
LEFT JOIN public.people c ON ei.person_id = c.id;

-- ==========================================================================
-- 3. RLS Policies
-- ==========================================================================
ALTER TABLE public.events_interest ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_events_interest"
  ON public.events_interest FOR SELECT TO anon
  USING (true);

CREATE POLICY "authenticated_all_events_interest"
  ON public.events_interest FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ==========================================================================
-- 4. Realtime
-- ==========================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.events_interest;
ALTER TABLE public.events_interest REPLICA IDENTITY FULL;
