-- Gradual integration: sync jobs table
-- Tracks batch sync jobs for pushing registrations to the Gradual platform.

CREATE TABLE IF NOT EXISTS public.integrations_gradual_sync_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  gradual_eventslug       text,
  status                  text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_registrations     integer DEFAULT 0,
  processed_registrations integer DEFAULT 0,
  successful_syncs        integer DEFAULT 0,
  failed_syncs            integer DEFAULT 0,
  errors                  jsonb DEFAULT '[]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gradual_sync_jobs_event ON public.integrations_gradual_sync_jobs(event_id);
CREATE INDEX IF NOT EXISTS idx_gradual_sync_jobs_status ON public.integrations_gradual_sync_jobs(status);

DROP TRIGGER IF EXISTS integrations_gradual_sync_jobs_updated_at
  ON public.integrations_gradual_sync_jobs;
CREATE TRIGGER integrations_gradual_sync_jobs_updated_at
  BEFORE UPDATE ON public.integrations_gradual_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Column on events_registrations to track which registrations have been synced
ALTER TABLE public.events_registrations
  ADD COLUMN IF NOT EXISTS gradual_synced_at timestamptz;

-- Column on events to link to a Gradual event slug
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS gradual_eventslug text;

CREATE INDEX IF NOT EXISTS idx_events_gradual_eventslug
  ON public.events (gradual_eventslug)
  WHERE gradual_eventslug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inbound webhook side (integrations-gradual-webhook / -import-history)
-- ---------------------------------------------------------------------------

-- Allow 'gradual' as an events_attendance check-in method. The core events
-- module (events/001) defines this constraint without 'gradual'; the webhook's
-- check-in / attendance handlers insert check_in_method = 'gradual'.
ALTER TABLE public.events_attendance
  DROP CONSTRAINT IF EXISTS events_attendance_check_in_method_check;
ALTER TABLE public.events_attendance
  ADD CONSTRAINT events_attendance_check_in_method_check
  CHECK (check_in_method IN (
    'qr_scan', 'manual_entry', 'badge_scan', 'mobile_app', 'sponsor_booth', 'gradual'
  ));

-- Audit log of every inbound Gradual webhook (append-only, for debugging).
CREATE TABLE IF NOT EXISTS public.integrations_gradual_webhook_events (
  id            bigserial PRIMARY KEY,
  event_type    text NOT NULL,
  user_email    text,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_gradual_webhook_events_type
  ON public.integrations_gradual_webhook_events (event_type);
CREATE INDEX IF NOT EXISTS idx_gradual_webhook_events_email
  ON public.integrations_gradual_webhook_events (user_email);
CREATE INDEX IF NOT EXISTS idx_gradual_webhook_events_received
  ON public.integrations_gradual_webhook_events (received_at DESC);

COMMENT ON TABLE public.integrations_gradual_webhook_events IS
  'Logs incoming webhook events from the Gradual community platform for auditing and debugging.';

-- Registrations that arrived before their event existed in Gatewaze. Events are
-- normally pre-created (e.g. by the virtual-events scraper), so this is an edge
-- case; rows are queued here rather than lost, keyed by (gradual_eventslug, email).
CREATE TABLE IF NOT EXISTS public.integrations_gradual_pending_registrations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gradual_user_id           text,
  gradual_eventslug         text NOT NULL,
  user_email                text NOT NULL,
  user_first_name           text,
  user_last_name            text,
  user_company              text,
  user_title                text,
  user_linkedin             text,
  user_avatar_url           text,
  user_location             text,
  event_name                text,
  event_url                 text,
  registration_date         timestamptz,
  referring_code            text,
  referring_user_id         text,
  referring_user_email      text,
  event_questions           jsonb,
  utm_source                text,
  utm_medium                text,
  utm_campaign              text,
  utm_content               text,
  utm_term                  text,
  refer_url                 text,
  status                    text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'failed', 'skipped')),
  processed_at              timestamptz,
  error_message             text,
  created_person_id         uuid REFERENCES public.people(id) ON DELETE SET NULL,
  created_people_profile_id uuid REFERENCES public.people_profiles(id) ON DELETE SET NULL,
  created_registration_id   uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  raw_webhook_payload       jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gradual_eventslug, user_email)
);

CREATE INDEX IF NOT EXISTS idx_gradual_pending_registrations_status
  ON public.integrations_gradual_pending_registrations (status);
CREATE INDEX IF NOT EXISTS idx_gradual_pending_registrations_eventslug
  ON public.integrations_gradual_pending_registrations (gradual_eventslug);
CREATE INDEX IF NOT EXISTS idx_gradual_pending_registrations_email
  ON public.integrations_gradual_pending_registrations (user_email);

COMMENT ON TABLE public.integrations_gradual_pending_registrations IS
  'Queues Gradual registrations for events not yet present in Gatewaze.';

DROP TRIGGER IF EXISTS integrations_gradual_pending_registrations_updated_at
  ON public.integrations_gradual_pending_registrations;
CREATE TRIGGER integrations_gradual_pending_registrations_updated_at
  BEFORE UPDATE ON public.integrations_gradual_pending_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Attendance/check-in events that arrived before their event existed.
CREATE TABLE IF NOT EXISTS public.integrations_gradual_pending_attendance (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gradual_user_id           text,
  gradual_eventslug         text NOT NULL,
  user_email                text NOT NULL,
  user_first_name           text,
  user_last_name            text,
  user_company              text,
  user_title                text,
  user_linkedin             text,
  user_avatar_url           text,
  user_location             text,
  event_name                text,
  event_url                 text,
  attendance_date           timestamptz,
  status                    text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'failed', 'skipped')),
  processed_at              timestamptz,
  error_message             text,
  raw_webhook_payload       jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gradual_eventslug, user_email)
);

CREATE INDEX IF NOT EXISTS idx_gradual_pending_attendance_status
  ON public.integrations_gradual_pending_attendance (status);
CREATE INDEX IF NOT EXISTS idx_gradual_pending_attendance_eventslug
  ON public.integrations_gradual_pending_attendance (gradual_eventslug);

COMMENT ON TABLE public.integrations_gradual_pending_attendance IS
  'Queues Gradual attendance/check-in events for events not yet present in Gatewaze.';

DROP TRIGGER IF EXISTS integrations_gradual_pending_attendance_updated_at
  ON public.integrations_gradual_pending_attendance;
CREATE TRIGGER integrations_gradual_pending_attendance_updated_at
  BEFORE UPDATE ON public.integrations_gradual_pending_attendance
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: service-role (edge functions) full access.
ALTER TABLE public.integrations_gradual_webhook_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_gradual_pending_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_gradual_pending_attendance    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gradual_webhook_events_service_all
  ON public.integrations_gradual_webhook_events;
CREATE POLICY gradual_webhook_events_service_all
  ON public.integrations_gradual_webhook_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS gradual_pending_registrations_service_all
  ON public.integrations_gradual_pending_registrations;
CREATE POLICY gradual_pending_registrations_service_all
  ON public.integrations_gradual_pending_registrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS gradual_pending_attendance_service_all
  ON public.integrations_gradual_pending_attendance;
CREATE POLICY gradual_pending_attendance_service_all
  ON public.integrations_gradual_pending_attendance
  FOR ALL TO service_role USING (true) WITH CHECK (true);
