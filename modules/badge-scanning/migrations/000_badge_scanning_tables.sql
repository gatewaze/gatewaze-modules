-- ============================================================================
-- Module: badge-scanning
-- Migration: 000_badge_scanning_tables
-- Description: Core badge printing, QR access token, and contact scan tables.
--              Moved from core 00005_people_extended.sql and renamed from
--              people_ prefix to events_ prefix.
-- ============================================================================

-- ==========================================================================
-- 1. events_badge_templates
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_badge_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  description          text,
  template_type        text CHECK (template_type IN ('standard', 'vip', 'speaker', 'sponsor', 'staff')) DEFAULT 'standard',
  paper_size           text CHECK (paper_size IN ('62mm', '102mm', 'custom')) DEFAULT '62mm',
  width_mm             integer,
  height_mm            integer,
  layout_config        jsonb DEFAULT '{}',
  include_qr           boolean DEFAULT true,
  include_photo        boolean DEFAULT true,
  include_company      boolean DEFAULT true,
  include_title        boolean DEFAULT true,
  background_image_url text,
  logo_url             text,
  is_default           boolean DEFAULT false,
  is_active            boolean DEFAULT true,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

COMMENT ON TABLE public.events_badge_templates IS 'Badge layout templates used when printing attendee badges.';

CREATE INDEX IF NOT EXISTS idx_events_badge_templates_type
  ON public.events_badge_templates (template_type);

CREATE INDEX IF NOT EXISTS idx_events_badge_templates_active
  ON public.events_badge_templates (is_active) WHERE is_active = true;

CREATE TRIGGER events_badge_templates_updated_at
  BEFORE UPDATE ON public.events_badge_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_badge_print_jobs
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_badge_print_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          varchar REFERENCES public.events(event_id) NOT NULL,
  job_type          text CHECK (job_type IN ('bulk_pre_event', 'on_demand', 'reprint', 'vip_batch')) NOT NULL,
  status            text CHECK (status IN ('queued', 'printing', 'completed', 'failed', 'cancelled')) DEFAULT 'queued',
  total_badges      integer DEFAULT 0,
  printed_count     integer DEFAULT 0,
  failed_count      integer DEFAULT 0,
  printer_id        text,
  printer_location  text,
  badge_template_id uuid REFERENCES public.events_badge_templates(id),
  print_settings    jsonb DEFAULT '{}',
  created_by        uuid REFERENCES public.admin_profiles(id),
  queued_at         timestamptz DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  error_message     text,
  created_at        timestamptz DEFAULT now()
);

COMMENT ON TABLE public.events_badge_print_jobs IS 'Batch or on-demand badge print jobs tied to an event.';

CREATE INDEX IF NOT EXISTS idx_events_badge_print_jobs_event
  ON public.events_badge_print_jobs (event_id);

CREATE INDEX IF NOT EXISTS idx_events_badge_print_jobs_status
  ON public.events_badge_print_jobs (status);

CREATE INDEX IF NOT EXISTS idx_events_badge_print_jobs_template
  ON public.events_badge_print_jobs (badge_template_id);

-- ==========================================================================
-- 3. events_badge_prints
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_badge_prints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              varchar REFERENCES public.events(event_id) NOT NULL,
  people_profile_id     uuid REFERENCES public.people_profiles(id) NOT NULL,
  event_registration_id uuid REFERENCES public.events_registrations(id),
  print_job_id          uuid REFERENCES public.events_badge_print_jobs(id),
  print_type            text CHECK (print_type IN ('pre_event', 'check_in', 'replacement', 'vip')) NOT NULL,
  print_reason          text,
  printer_id            text,
  print_settings        jsonb DEFAULT '{}',
  qr_code_id            varchar(12) NOT NULL,
  qr_token_hash         text,
  printed_by            uuid REFERENCES public.admin_profiles(id),
  print_status          text CHECK (print_status IN ('queued', 'printing', 'printed', 'failed')) DEFAULT 'queued',
  error_message         text,
  printed_at            timestamptz DEFAULT now(),
  created_at            timestamptz DEFAULT now()
);

COMMENT ON TABLE public.events_badge_prints IS 'Individual badge print records — one row per physical badge printed.';

CREATE INDEX IF NOT EXISTS idx_events_badge_prints_event
  ON public.events_badge_prints (event_id);

CREATE INDEX IF NOT EXISTS idx_events_badge_prints_profile
  ON public.events_badge_prints (people_profile_id);

CREATE INDEX IF NOT EXISTS idx_events_badge_prints_job
  ON public.events_badge_prints (print_job_id);

CREATE INDEX IF NOT EXISTS idx_events_badge_prints_registration
  ON public.events_badge_prints (event_registration_id);

CREATE INDEX IF NOT EXISTS idx_events_badge_prints_status
  ON public.events_badge_prints (print_status);

-- ==========================================================================
-- 4. events_qr_access_tokens
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_qr_access_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  people_profile_id uuid REFERENCES public.people_profiles(id) NOT NULL,
  token_hash        text UNIQUE NOT NULL,
  expires_at        timestamptz NOT NULL,
  used_count        integer DEFAULT 0,
  last_used_at      timestamptz,
  created_at        timestamptz DEFAULT now()
);

COMMENT ON TABLE public.events_qr_access_tokens IS 'Short-lived hashed tokens embedded in QR codes for profile access.';

CREATE INDEX IF NOT EXISTS idx_events_qr_access_tokens_profile
  ON public.events_qr_access_tokens (people_profile_id);

CREATE INDEX IF NOT EXISTS idx_events_qr_access_tokens_hash
  ON public.events_qr_access_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_events_qr_access_tokens_expires
  ON public.events_qr_access_tokens (expires_at);

-- ==========================================================================
-- 5. events_contact_scans
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_contact_scans (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scanner_people_profile_id  uuid REFERENCES public.people_profiles(id) NOT NULL,
  scanned_people_profile_id  uuid REFERENCES public.people_profiles(id) NOT NULL,
  event_id                   varchar REFERENCES public.events(event_id) NOT NULL,
  event_sponsor_id           uuid,  -- FK to events_sponsors added by event-sponsors module if installed
  scan_context               text CHECK (scan_context IN ('personal', 'sponsor_booth', 'speaker_session', 'networking')) DEFAULT 'personal',
  location                   text,
  rating                     integer CHECK (rating >= 1 AND rating <= 5),
  interest_level             text CHECK (interest_level IN ('hot', 'warm', 'cold')),
  notes                      text,
  tags                       text[],
  follow_up_required         boolean DEFAULT false,
  scanned_at                 timestamptz DEFAULT now(),
  scan_metadata              jsonb DEFAULT '{}',
  UNIQUE(scanner_people_profile_id, scanned_people_profile_id, event_id)
);

COMMENT ON TABLE public.events_contact_scans IS 'Records of QR-based contact exchanges between attendees at events.';

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_scanner
  ON public.events_contact_scans (scanner_people_profile_id);

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_scanned
  ON public.events_contact_scans (scanned_people_profile_id);

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_event
  ON public.events_contact_scans (event_id);

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_sponsor
  ON public.events_contact_scans (event_sponsor_id) WHERE event_sponsor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_context
  ON public.events_contact_scans (scan_context);

CREATE INDEX IF NOT EXISTS idx_events_contact_scans_follow_up
  ON public.events_contact_scans (follow_up_required) WHERE follow_up_required = true;
