-- ============================================================================
-- Module: event-invites
-- Migration: 001_event_invites
-- Description: Calendar invite tracking and interactions. Based on the
--              calendars_invites / calendars_interactions tables from the
--              calendar system, rewritten as module tables with RSVP support,
--              invite batches, and a details view.
-- ============================================================================

-- ==========================================================================
-- 1. Event invites
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id varchar REFERENCES public.events(event_id) ON DELETE CASCADE,
  registration_id uuid REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  people_profile_id uuid REFERENCES public.people_profiles(id),
  token varchar(64) UNIQUE NOT NULL,
  expires_at timestamptz,
  total_clicks integer DEFAULT 0,
  last_clicked_at timestamptz,
  google_calendar_clicks integer DEFAULT 0,
  outlook_calendar_clicks integer DEFAULT 0,
  apple_calendar_clicks integer DEFAULT 0,
  ics_download_clicks integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT valid_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_calendars_invites_token ON public.calendars_invites(token);
CREATE INDEX IF NOT EXISTS idx_calendars_invites_event ON public.calendars_invites(event_id);

CREATE TRIGGER calendars_invites_updated_at
  BEFORE UPDATE ON public.calendars_invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.calendars_invites IS 'Calendar invite links with per-client click tracking';

-- ==========================================================================
-- 2. Calendar interactions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_interactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  invite_id uuid REFERENCES public.calendars_invites(id) ON DELETE CASCADE,
  interaction_type varchar(50) NOT NULL,
  ip_address inet,
  user_agent text,
  referer text,
  calendar_client varchar(100),
  device_type varchar(50),
  browser varchar(50),
  os varchar(50),
  country varchar(2),
  city varchar(100),
  response_time_ms integer,
  success boolean DEFAULT true,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendars_interactions_invite ON public.calendars_interactions(invite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendars_interactions_type ON public.calendars_interactions(interaction_type, created_at DESC);

COMMENT ON TABLE public.calendars_interactions IS 'Tracks each visit/click on a calendar invite link';

-- ==========================================================================
-- 3. RLS
-- ==========================================================================
ALTER TABLE public.calendars_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendars_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_calendars_invites" ON public.calendars_invites FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_calendars_interactions" ON public.calendars_interactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
