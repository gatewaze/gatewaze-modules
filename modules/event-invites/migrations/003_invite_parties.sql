-- ============================================================================
-- Module: event-invites
-- Migration: 003_invite_parties
-- Description: Replace flat event_invites with grouped party-based invite
--              system. Creates invite_parties, invite_party_members,
--              invite_party_member_events, invite_questions, invite_responses,
--              invite_reminder_config, invite_reminder_log, and updates
--              event_invite_interactions. Adds views and RLS policies.
-- ============================================================================

-- ==========================================================================
-- 1. invite_parties — a group of people invited together
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token varchar(64) UNIQUE NOT NULL,
  short_code varchar(12) UNIQUE NOT NULL,
  max_plus_ones integer DEFAULT 0,
  plus_ones_added integer DEFAULT 0,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'send_failed', 'opened', 'partially_responded', 'responded', 'expired', 'cancelled')),
  delivery_channel text DEFAULT 'email'
    CHECK (delivery_channel IN ('email', 'sms', 'whatsapp')),
  sent_at timestamptz,
  opened_at timestamptz,
  responded_at timestamptz,
  notes text,
  batch_id uuid REFERENCES public.event_invite_batches(id) ON DELETE SET NULL,
  version integer DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_parties_token ON public.invite_parties(token);
CREATE INDEX IF NOT EXISTS idx_invite_parties_short_code ON public.invite_parties(short_code);
CREATE INDEX IF NOT EXISTS idx_invite_parties_batch ON public.invite_parties(batch_id);
CREATE INDEX IF NOT EXISTS idx_invite_parties_status ON public.invite_parties(status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_parties_updated_at') THEN
    CREATE TRIGGER invite_parties_updated_at
      BEFORE UPDATE ON public.invite_parties
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 2. invite_party_members — each person in a party
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_party_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.invite_parties(id) ON DELETE CASCADE,
  person_id uuid REFERENCES public.people(id),
  first_name text,
  last_name text,
  email text,
  phone text,
  is_lead_booker boolean DEFAULT false,
  is_plus_one boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_party_members_party ON public.invite_party_members(party_id);
CREATE INDEX IF NOT EXISTS idx_invite_party_members_person ON public.invite_party_members(person_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_party_members_updated_at') THEN
    CREATE TRIGGER invite_party_members_updated_at
      BEFORE UPDATE ON public.invite_party_members
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 3. invite_party_member_events — per-member per-event RSVP tracking
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_party_member_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_member_id uuid NOT NULL REFERENCES public.invite_party_members(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  rsvp_status text DEFAULT 'pending'
    CHECK (rsvp_status IN ('pending', 'accepted', 'declined', 'maybe')),
  rsvp_responded_at timestamptz,
  rsvp_deadline timestamptz,
  registration_id uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_member_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_party_member_events_member ON public.invite_party_member_events(party_member_id);
CREATE INDEX IF NOT EXISTS idx_invite_party_member_events_event ON public.invite_party_member_events(event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_party_member_events_updated_at') THEN
    CREATE TRIGGER invite_party_member_events_updated_at
      BEFORE UPDATE ON public.invite_party_member_events
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 4. invite_questions — configurable follow-up questions per event
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  question_text text NOT NULL,
  question_type text NOT NULL DEFAULT 'select'
    CHECK (question_type IN ('select', 'multi_select', 'text', 'yes_no')),
  options jsonb,
  is_required boolean DEFAULT false,
  applies_to text DEFAULT 'all'
    CHECK (applies_to IN ('all', 'accepted_only')),
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_questions_event ON public.invite_questions(event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_questions_updated_at') THEN
    CREATE TRIGGER invite_questions_updated_at
      BEFORE UPDATE ON public.invite_questions
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 5. invite_responses — answers to follow-up questions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_member_event_id uuid NOT NULL REFERENCES public.invite_party_member_events(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.invite_questions(id) ON DELETE CASCADE,
  answer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_member_event_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_responses_member_event ON public.invite_responses(party_member_event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_responses_updated_at') THEN
    CREATE TRIGGER invite_responses_updated_at
      BEFORE UPDATE ON public.invite_responses
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 6. event_invite_interactions — replace old table with party-based version
-- ==========================================================================
DROP TABLE IF EXISTS public.event_invite_interactions CASCADE;

CREATE TABLE public.event_invite_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.invite_parties(id) ON DELETE CASCADE,
  interaction_type text NOT NULL,
  ip_address inet,
  user_agent text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_invite_interactions_party
  ON public.event_invite_interactions(party_id, created_at DESC);

-- ==========================================================================
-- 7. invite_reminder_config — per-event reminder rules
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_reminder_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  days_before_deadline integer NOT NULL,
  template_id uuid,
  sms_template text,
  enabled boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, days_before_deadline)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_reminder_config_updated_at') THEN
    CREATE TRIGGER invite_reminder_config_updated_at
      BEFORE UPDATE ON public.invite_reminder_config
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 8. invite_reminder_log — track which parties received which reminders
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_config_id uuid NOT NULL REFERENCES public.invite_reminder_config(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES public.invite_parties(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivery_channel text NOT NULL,
  UNIQUE (reminder_config_id, party_id)
);

-- ==========================================================================
-- 9. Views
-- ==========================================================================

-- Aggregated party view for admin dashboard
CREATE OR REPLACE VIEW public.invite_parties_with_stats AS
SELECT
  p.*,
  COUNT(DISTINCT pm.id) AS member_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'accepted') AS accepted_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'declined') AS declined_count,
  COUNT(DISTINCT pme.id) FILTER (WHERE pme.rsvp_status = 'pending') AS pending_count,
  lb.first_name AS lead_first_name,
  lb.last_name AS lead_last_name,
  lb.email AS lead_email,
  array_agg(DISTINCT pme.event_id) FILTER (WHERE pme.event_id IS NOT NULL) AS event_ids
FROM public.invite_parties p
LEFT JOIN public.invite_party_members pm ON pm.party_id = p.id
LEFT JOIN public.invite_party_member_events pme ON pme.party_member_id = pm.id
LEFT JOIN public.invite_party_members lb ON lb.party_id = p.id AND lb.is_lead_booker = true
GROUP BY p.id, lb.first_name, lb.last_name, lb.email;

-- Per-member-event detail view for portal RSVP page
CREATE OR REPLACE VIEW public.invite_party_detail AS
SELECT
  pm.id AS member_id,
  pm.party_id,
  pm.first_name,
  pm.last_name,
  pm.email,
  pm.is_lead_booker,
  pm.is_plus_one,
  pm.sort_order,
  pme.id AS member_event_id,
  pme.event_id,
  pme.rsvp_status,
  pme.rsvp_deadline,
  pme.rsvp_responded_at,
  e.event_title,
  e.event_start,
  e.event_end,
  e.event_location,
  p.token AS party_token,
  p.short_code AS party_short_code,
  p.name AS party_name,
  p.status AS party_status,
  p.max_plus_ones,
  p.plus_ones_added,
  p.version AS party_version
FROM public.invite_party_members pm
JOIN public.invite_parties p ON p.id = pm.party_id
LEFT JOIN public.invite_party_member_events pme ON pme.party_member_id = pm.id
LEFT JOIN public.events e ON e.id = pme.event_id;

-- ==========================================================================
-- 10. RLS Policies
-- ==========================================================================

-- invite_parties
ALTER TABLE public.invite_parties ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_parties' AND policyname = 'authenticated_select_invite_parties') THEN
    CREATE POLICY "authenticated_select_invite_parties"
      ON public.invite_parties FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_parties' AND policyname = 'authenticated_all_invite_parties') THEN
    CREATE POLICY "authenticated_all_invite_parties"
      ON public.invite_parties FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_party_members
ALTER TABLE public.invite_party_members ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_party_members' AND policyname = 'authenticated_all_invite_party_members') THEN
    CREATE POLICY "authenticated_all_invite_party_members"
      ON public.invite_party_members FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_party_member_events
ALTER TABLE public.invite_party_member_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_party_member_events' AND policyname = 'authenticated_all_invite_party_member_events') THEN
    CREATE POLICY "authenticated_all_invite_party_member_events"
      ON public.invite_party_member_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_questions
ALTER TABLE public.invite_questions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_questions' AND policyname = 'authenticated_all_invite_questions') THEN
    CREATE POLICY "authenticated_all_invite_questions"
      ON public.invite_questions FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_responses
ALTER TABLE public.invite_responses ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_responses' AND policyname = 'authenticated_all_invite_responses') THEN
    CREATE POLICY "authenticated_all_invite_responses"
      ON public.invite_responses FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- event_invite_interactions (already dropped and recreated above)
ALTER TABLE public.event_invite_interactions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invite_interactions' AND policyname = 'authenticated_all_event_invite_interactions') THEN
    CREATE POLICY "authenticated_all_event_invite_interactions"
      ON public.event_invite_interactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_reminder_config
ALTER TABLE public.invite_reminder_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_reminder_config' AND policyname = 'authenticated_all_invite_reminder_config') THEN
    CREATE POLICY "authenticated_all_invite_reminder_config"
      ON public.invite_reminder_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- invite_reminder_log
ALTER TABLE public.invite_reminder_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_reminder_log' AND policyname = 'authenticated_all_invite_reminder_log') THEN
    CREATE POLICY "authenticated_all_invite_reminder_log"
      ON public.invite_reminder_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
