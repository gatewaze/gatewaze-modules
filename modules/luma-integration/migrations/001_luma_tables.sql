-- ============================================================================
-- Module: luma-integration
-- Migration: 001_luma_tables
-- Description: Luma integration tables - calendar members, event registrations,
--              pending registrations, CSV uploads
-- ============================================================================

-- Luma calendar members
CREATE TABLE IF NOT EXISTS public.integrations_luma_calendar_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id text NOT NULL,
  luma_user_id text NOT NULL,
  luma_calendar_id text,
  email text NOT NULL,
  name text,
  first_name text,
  last_name text,
  first_seen_at timestamptz,
  tags text[],
  revenue text,
  event_approved_count integer DEFAULT 0,
  event_checked_in_count integer DEFAULT 0,
  membership_name text,
  membership_status text,
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by_admin_id uuid REFERENCES public.admin_profiles(id),
  raw_csv_row jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(brand_id, luma_user_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_luma_calendar_members_brand ON public.integrations_luma_calendar_members(brand_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_calendar_members_user_id ON public.integrations_luma_calendar_members(luma_user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_calendar_members_email ON public.integrations_luma_calendar_members(email);

COMMENT ON TABLE public.integrations_luma_calendar_members IS 'Stores Luma calendar member data from CSV uploads';

CREATE TRIGGER integrations_luma_calendar_members_updated_at
  BEFORE UPDATE ON public.integrations_luma_calendar_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Luma event registrations
CREATE TABLE IF NOT EXISTS public.integrations_luma_event_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id text NOT NULL,
  luma_guest_id text NOT NULL,
  luma_event_id text NOT NULL,
  email text NOT NULL,
  name text,
  first_name text,
  last_name text,
  phone_number text,
  luma_approval_status text,
  luma_checked_in_at timestamptz,
  luma_qr_code_url text,
  luma_custom_source text,
  luma_ticket_type_id text,
  luma_ticket_name text,
  luma_registered_at timestamptz,
  amount decimal(10,2),
  amount_tax decimal(10,2),
  amount_discount decimal(10,2),
  currency text,
  coupon_code text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'skipped')),
  processed_at timestamptz,
  skip_reason text,
  created_person_id uuid REFERENCES public.people(id),
  created_people_profile_id uuid REFERENCES public.people_profiles(id),
  created_registration_id uuid REFERENCES public.events_registrations(id),
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by_admin_id uuid REFERENCES public.admin_profiles(id),
  raw_csv_row jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(brand_id, luma_event_id, luma_guest_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_luma_event_registrations_brand ON public.integrations_luma_event_registrations(brand_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_event_registrations_event ON public.integrations_luma_event_registrations(luma_event_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_event_registrations_email ON public.integrations_luma_event_registrations(email);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_event_registrations_status ON public.integrations_luma_event_registrations(status);

COMMENT ON TABLE public.integrations_luma_event_registrations IS 'Stores Luma event guest data from CSV uploads';

CREATE TRIGGER integrations_luma_event_registrations_updated_at
  BEFORE UPDATE ON public.integrations_luma_event_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Luma pending registrations
CREATE TABLE IF NOT EXISTS public.integrations_luma_pending_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id text NOT NULL,
  luma_user_id text NOT NULL,
  luma_event_id text NOT NULL,
  user_name text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'processed', 'failed', 'no_event')),
  matched_at timestamptz,
  processed_at timestamptz,
  error_message text,
  matched_email text,
  matched_via text,
  matched_luma_registration_id uuid REFERENCES public.integrations_luma_event_registrations(id),
  created_person_id uuid REFERENCES public.people(id),
  created_people_profile_id uuid REFERENCES public.people_profiles(id),
  created_registration_id uuid REFERENCES public.events_registrations(id),
  email_received_at timestamptz DEFAULT now(),
  email_from text,
  email_to text,
  email_subject text,
  short_link_url text,
  resolved_url text,
  raw_email_data jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(brand_id, luma_event_id, luma_user_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_luma_pending_registrations_brand ON public.integrations_luma_pending_registrations(brand_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_pending_registrations_status ON public.integrations_luma_pending_registrations(status);

COMMENT ON TABLE public.integrations_luma_pending_registrations IS 'Queues Luma registration notifications until user identity can be resolved';

CREATE TRIGGER integrations_luma_pending_registrations_updated_at
  BEFORE UPDATE ON public.integrations_luma_pending_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Luma CSV uploads
CREATE TABLE IF NOT EXISTS public.integrations_luma_csv_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id text NOT NULL,
  file_name text NOT NULL,
  csv_type text NOT NULL CHECK (csv_type IN ('event_guests', 'calendar_members')),
  row_count integer NOT NULL DEFAULT 0,
  csv_data jsonb NOT NULL,
  csv_headers text[] NOT NULL,
  event_id varchar(255) REFERENCES public.events(event_id),
  luma_calendar_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  processed_rows integer DEFAULT 0,
  error_count integer DEFAULT 0,
  errors jsonb DEFAULT '[]'::jsonb,
  registrations_created integer DEFAULT 0,
  luma_event_id text,
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by_admin_id uuid REFERENCES public.admin_profiles(id),
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_luma_csv_uploads_brand ON public.integrations_luma_csv_uploads(brand_id);
CREATE INDEX IF NOT EXISTS idx_integrations_luma_csv_uploads_status ON public.integrations_luma_csv_uploads(status);

COMMENT ON TABLE public.integrations_luma_csv_uploads IS 'Tracks Luma CSV uploads for background processing';

CREATE TRIGGER integrations_luma_csv_uploads_updated_at
  BEFORE UPDATE ON public.integrations_luma_csv_uploads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.integrations_luma_calendar_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_luma_event_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_luma_pending_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_luma_csv_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_integrations_luma_calendar_members" ON public.integrations_luma_calendar_members FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_luma_event_registrations" ON public.integrations_luma_event_registrations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_luma_pending_registrations" ON public.integrations_luma_pending_registrations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_luma_csv_uploads" ON public.integrations_luma_csv_uploads FOR ALL TO authenticated USING (true) WITH CHECK (true);
