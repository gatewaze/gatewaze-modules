-- ==========================================================================
-- events_communication_settings - Per-event email communication settings
-- This table is shared across modules (bulk-emailing, competitions,
-- event-speakers, luma). Using IF NOT EXISTS so it's safe
-- regardless of installation order.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'events_comm_settings_updated_at'
  ) THEN
    CREATE TRIGGER events_comm_settings_updated_at
      BEFORE UPDATE ON public.events_communication_settings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.events_communication_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'events_communication_settings'
    AND policyname = 'authenticated_all_events_communication_settings'
  ) THEN
    CREATE POLICY "authenticated_all_events_communication_settings"
      ON public.events_communication_settings FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;
