-- Attendee Matching Module
-- AI-powered 1:1 attendee matching for pre-event networking introductions

-- ─── Matches table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.events_attendee_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(10) NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  registration_a_id UUID NOT NULL REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  registration_b_id UUID NOT NULL REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  match_score NUMERIC(4,2),
  match_reason TEXT,
  preceding_word_a TEXT,
  preceding_word_b TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  intro_email_sent_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each registrant can only appear once per event (as either A or B)
  UNIQUE (event_id, registration_a_id),
  UNIQUE (event_id, registration_b_id)
);

CREATE INDEX IF NOT EXISTS idx_events_attendee_matches_event_id
  ON public.events_attendee_matches(event_id);

CREATE INDEX IF NOT EXISTS idx_events_attendee_matches_status
  ON public.events_attendee_matches(event_id, status);

CREATE TRIGGER set_events_attendee_matches_updated_at
  BEFORE UPDATE ON public.events_attendee_matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.events_attendee_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage attendee matches"
  ON public.events_attendee_matches
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ─── Match email settings on event_communication_settings ────────────────────
-- (only if the table exists — it's part of core platform)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'event_communication_settings') THEN
    ALTER TABLE public.event_communication_settings
      ADD COLUMN IF NOT EXISTS match_intro_email_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS match_intro_email_template_id UUID REFERENCES public.email_templates(id),
      ADD COLUMN IF NOT EXISTS match_intro_email_from_key TEXT DEFAULT 'events',
      ADD COLUMN IF NOT EXISTS match_intro_email_from_address TEXT,
      ADD COLUMN IF NOT EXISTS match_intro_email_reply_to TEXT,
      ADD COLUMN IF NOT EXISTS match_intro_email_subject TEXT,
      ADD COLUMN IF NOT EXISTS match_intro_email_content TEXT;
  END IF;
END $$;

-- ─── Communication settings table (created if not exists) ────────────────────
-- Standalone fallback for platforms without the core event_communication_settings

CREATE TABLE IF NOT EXISTS public.events_match_email_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(10) NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  from_address TEXT,
  from_key TEXT DEFAULT 'events',
  reply_to TEXT,
  template_id UUID REFERENCES public.email_templates(id),
  subject TEXT,
  content TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);

CREATE TRIGGER set_events_match_email_settings_updated_at
  BEFORE UPDATE ON public.events_match_email_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.events_match_email_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage match email settings"
  ON public.events_match_email_settings
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ─── View: registrations with people data (for matching queries) ─────────────

CREATE OR REPLACE VIEW public.events_registrations_matching_view AS
SELECT
  er.id,
  e.event_id,
  er.person_id,
  er.status,
  er.registration_type,
  er.ticket_type,
  er.registered_at,
  p.email,
  p.attributes->>'first_name' AS first_name,
  p.attributes->>'last_name' AS last_name,
  concat_ws(' ', p.attributes->>'first_name', p.attributes->>'last_name') AS full_name,
  p.attributes->>'company' AS company,
  p.attributes->>'job_title' AS job_title,
  e.event_title,
  e.event_start,
  e.event_end,
  e.event_link
FROM public.events_registrations er
  JOIN public.events e ON er.event_id = e.id
  LEFT JOIN public.people p ON er.person_id = p.id;
