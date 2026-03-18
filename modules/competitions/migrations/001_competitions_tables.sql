-- ============================================================================
-- Module: competitions
-- Migration: 001_competitions_tables
-- Description: Tables for attendee matching, competitions, communication
--              settings, and email batch jobs.
-- NOTE: events_interest lives in the event-interest module.
-- NOTE: Ad tracking tables live in the event-tracking module.
-- ============================================================================

-- ==========================================================================
-- 1. events_attendee_matches - AI-generated attendee matches
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_attendee_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  registration_a_id uuid NOT NULL REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  registration_b_id uuid NOT NULL REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  match_score numeric(5,2),
  match_reason text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  intro_email_sent_at timestamptz,
  preceding_word_a text,
  preceding_word_b text,
  generated_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_attendee_matches_event ON public.events_attendee_matches (event_id);

CREATE TRIGGER events_attendee_matches_updated_at
  BEFORE UPDATE ON public.events_attendee_matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 4. events_competitions - Competitions/giveaways for events
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text,
  description text,
  prize_description text,
  competition_type text DEFAULT 'giveaway' CHECK (competition_type IN ('giveaway', 'raffle', 'contest', 'quiz')),
  status text DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed', 'completed')),
  value text,
  close_date timestamptz,
  close_display text,
  result text,
  intro text,
  content text,
  is_beta boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  start_date timestamptz,
  end_date timestamptz,
  max_entries integer,
  sponsor_id uuid,
  rules text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_competitions_event ON public.events_competitions (event_id);
CREATE INDEX IF NOT EXISTS idx_events_competitions_slug ON public.events_competitions (slug);

CREATE TRIGGER events_competitions_updated_at
  BEFORE UPDATE ON public.events_competitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 5. events_competition_entries - Entries for competitions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_competition_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES public.events_competitions(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  entry_data jsonb,
  status text DEFAULT 'active' CHECK (status IN ('active', 'winner', 'disqualified')),
  entered_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_competition_entries_comp ON public.events_competition_entries (competition_id);
CREATE INDEX IF NOT EXISTS idx_events_competition_entries_customer ON public.events_competition_entries (person_id);

-- ==========================================================================
-- 6. events_competition_winners - Selected winners
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_competition_winners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES public.events_competitions(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.events_competition_entries(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  prize_awarded text,
  discount_code_id uuid,
  notified_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_competition_winners_comp ON public.events_competition_winners (competition_id);

-- Conditional FK: competitions.sponsor_id → events_sponsors (if sponsors module installed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_competitions_sponsor_id_fkey') THEN
      ALTER TABLE public.events_competitions
        ADD CONSTRAINT events_competitions_sponsor_id_fkey
        FOREIGN KEY (sponsor_id) REFERENCES public.events_sponsors(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- Conditional FK: competition_winners.discount_code_id → events_discount_codes (if discounts module installed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_discount_codes') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_competition_winners_discount_code_id_fkey') THEN
      ALTER TABLE public.events_competition_winners
        ADD CONSTRAINT events_competition_winners_discount_code_id_fkey
        FOREIGN KEY (discount_code_id) REFERENCES public.events_discount_codes(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 7. events_communication_settings - Per-event email communication settings
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_communication_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE UNIQUE,
  registration_email_enabled boolean DEFAULT true,
  registration_email_template_id uuid,
  registration_email_from_key text DEFAULT 'events',
  registration_email_reply_to text,
  registration_email_cc text,
  registration_email_subject text,
  registration_email_content text,
  reminder_email_enabled boolean DEFAULT false,
  reminder_email_template_id uuid,
  reminder_email_from_key text DEFAULT 'events',
  reminder_email_reply_to text,
  reminder_email_cc text,
  reminder_email_subject text,
  reminder_email_content text,
  reminder_email_sent_at timestamptz,
  speaker_submitted_email_enabled boolean DEFAULT true,
  speaker_submitted_email_template_id uuid,
  speaker_submitted_email_from_key text DEFAULT 'events',
  speaker_submitted_email_reply_to text,
  speaker_submitted_email_cc text,
  speaker_submitted_email_subject text,
  speaker_submitted_email_content text,
  speaker_approved_email_enabled boolean DEFAULT true,
  speaker_approved_email_template_id uuid,
  speaker_approved_email_from_key text DEFAULT 'events',
  speaker_approved_email_reply_to text,
  speaker_approved_email_cc text,
  speaker_approved_email_subject text,
  speaker_approved_email_content text,
  speaker_rejected_email_enabled boolean DEFAULT true,
  speaker_rejected_email_template_id uuid,
  speaker_rejected_email_from_key text DEFAULT 'events',
  speaker_rejected_email_reply_to text,
  speaker_rejected_email_cc text,
  speaker_rejected_email_subject text,
  speaker_rejected_email_content text,
  speaker_reserve_email_enabled boolean DEFAULT true,
  speaker_reserve_email_template_id uuid,
  speaker_reserve_email_from_key text DEFAULT 'events',
  speaker_reserve_email_reply_to text,
  speaker_reserve_email_cc text,
  speaker_reserve_email_subject text,
  speaker_reserve_email_content text,
  speaker_confirmed_email_enabled boolean DEFAULT true,
  speaker_confirmed_email_template_id uuid,
  speaker_confirmed_email_from_key text DEFAULT 'events',
  speaker_confirmed_email_reply_to text,
  speaker_confirmed_email_cc text,
  speaker_confirmed_email_subject text,
  speaker_confirmed_email_content text,
  post_event_attendee_email_enabled boolean DEFAULT false,
  post_event_attendee_email_template_id uuid,
  post_event_attendee_email_from_key text DEFAULT 'events',
  post_event_attendee_email_reply_to text,
  post_event_attendee_email_cc text,
  post_event_attendee_email_subject text,
  post_event_attendee_email_content text,
  post_event_non_attendee_email_enabled boolean DEFAULT false,
  post_event_non_attendee_email_template_id uuid,
  post_event_non_attendee_email_from_key text DEFAULT 'events',
  post_event_non_attendee_email_reply_to text,
  post_event_non_attendee_email_cc text,
  post_event_non_attendee_email_subject text,
  post_event_non_attendee_email_content text,
  registrant_email_enabled boolean DEFAULT false,
  registrant_email_template_id uuid,
  registrant_email_from_key text DEFAULT 'events',
  registrant_email_reply_to text,
  registrant_email_cc text,
  registrant_email_subject text,
  registrant_email_content text,
  match_intro_email_template_id uuid,
  match_intro_email_from_key text DEFAULT 'events',
  match_intro_email_reply_to text,
  match_intro_email_subject text,
  match_intro_email_content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER events_comm_settings_updated_at
  BEFORE UPDATE ON public.events_communication_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- NOTE: integrations_ad_tracking_sessions and integrations_conversion_log
-- have been moved to the event-tracking module.

-- ==========================================================================
-- 10. email_batch_jobs - Batch email jobs
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES public.events(id) ON DELETE CASCADE,
  email_type text NOT NULL,
  subject_template text,
  template_id uuid,
  from_email text,
  reply_to text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_recipients integer DEFAULT 0,
  processed_count integer DEFAULT 0,
  success_count integer DEFAULT 0,
  fail_count integer DEFAULT 0,
  errors jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_batch_jobs_event ON public.email_batch_jobs (event_id);

CREATE TRIGGER email_batch_jobs_updated_at
  BEFORE UPDATE ON public.email_batch_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 11. RLS Policies
-- ==========================================================================

-- events_attendee_matches
ALTER TABLE public.events_attendee_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_events_attendee_matches"
  ON public.events_attendee_matches FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- events_competitions
ALTER TABLE public.events_competitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_events_competitions"
  ON public.events_competitions FOR SELECT TO anon
  USING (true);

CREATE POLICY "authenticated_all_events_competitions"
  ON public.events_competitions FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- events_competition_entries
ALTER TABLE public.events_competition_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_events_competition_entries"
  ON public.events_competition_entries FOR SELECT TO anon
  USING (true);

CREATE POLICY "authenticated_all_events_competition_entries"
  ON public.events_competition_entries FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- events_competition_winners
ALTER TABLE public.events_competition_winners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_events_competition_winners"
  ON public.events_competition_winners FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- events_communication_settings
ALTER TABLE public.events_communication_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_events_communication_settings"
  ON public.events_communication_settings FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- email_batch_jobs
ALTER TABLE public.email_batch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_email_batch_jobs"
  ON public.email_batch_jobs FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
