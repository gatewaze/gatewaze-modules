-- ============================================================================
-- Module: compliance
-- Migration: 001_compliance_tables
-- Description: Create GDPR/CCPA compliance tables
-- ============================================================================

-- Add CCPA columns to people table if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'do_not_sell'
  ) THEN
    ALTER TABLE public.people ADD COLUMN do_not_sell boolean;
    ALTER TABLE public.people ADD COLUMN do_not_sell_set_at timestamptz;
    ALTER TABLE public.people ADD COLUMN do_not_share boolean;
    ALTER TABLE public.people ADD COLUMN do_not_share_set_at timestamptz;
    ALTER TABLE public.people ADD COLUMN limit_sensitive_data_use boolean;
    ALTER TABLE public.people ADD COLUMN limit_sensitive_data_use_set_at timestamptz;
  END IF;
END $$;

-- Consent records
CREATE TABLE IF NOT EXISTS public.compliance_consent_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid REFERENCES public.people (id) ON DELETE SET NULL,
  email           varchar(255) NOT NULL,
  consent_type    varchar(100) NOT NULL,
  consented       boolean NOT NULL DEFAULT false,
  consent_text    text,
  ip_address      inet,
  user_agent      text,
  consented_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_consent_records IS 'GDPR consent records with audit trail';

CREATE INDEX IF NOT EXISTS idx_compliance_consent_person
  ON public.compliance_consent_records (person_id);
CREATE INDEX IF NOT EXISTS idx_compliance_consent_email
  ON public.compliance_consent_records (email);
CREATE INDEX IF NOT EXISTS idx_compliance_consent_type
  ON public.compliance_consent_records (consent_type);

-- Privacy requests (DSAR, erasure, etc.)
CREATE TABLE IF NOT EXISTS public.compliance_privacy_requests (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_person_id           uuid REFERENCES public.people (id) ON DELETE SET NULL,
  subject_email               varchar(255) NOT NULL,
  request_type                varchar(50) NOT NULL
                              CHECK (request_type IN (
                                'data_export', 'data_deletion', 'data_correction',
                                'data_portability', 'consent_withdrawal', 'processing_restriction'
                              )),
  status                      varchar(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected')),
  requested_at                timestamptz NOT NULL DEFAULT now(),
  processing_completed_at     timestamptz,
  requester_email             varchar(255) NOT NULL,
  notes                       text,
  processed_by                uuid,
  error_message               text,
  result_summary              jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_privacy_requests IS 'Data subject access requests and privacy right exercises';

CREATE INDEX IF NOT EXISTS idx_compliance_privacy_requests_person
  ON public.compliance_privacy_requests (subject_person_id);
CREATE INDEX IF NOT EXISTS idx_compliance_privacy_requests_email
  ON public.compliance_privacy_requests (subject_email);
CREATE INDEX IF NOT EXISTS idx_compliance_privacy_requests_status
  ON public.compliance_privacy_requests (status);
CREATE INDEX IF NOT EXISTS idx_compliance_privacy_requests_type
  ON public.compliance_privacy_requests (request_type);

CREATE TRIGGER compliance_privacy_requests_updated_at
  BEFORE UPDATE ON public.compliance_privacy_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Data breaches
CREATE TABLE IF NOT EXISTS public.compliance_data_breaches (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  breach_name                 varchar(500) NOT NULL,
  breach_description          text,
  severity                    varchar(20) NOT NULL DEFAULT 'medium'
                              CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status                      varchar(20) NOT NULL DEFAULT 'detected'
                              CHECK (status IN ('detected', 'investigating', 'contained', 'resolved', 'reported')),
  detected_at                 timestamptz NOT NULL DEFAULT now(),
  contained_at                timestamptz,
  resolved_at                 timestamptz,
  reported_to_authority_at    timestamptz,
  authority_reference         text,
  data_types_affected         text[],
  estimated_records_affected  integer,
  root_cause                  text,
  remediation_steps           text,
  lessons_learned             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_data_breaches IS 'Data breach incident records for regulatory compliance';

CREATE INDEX IF NOT EXISTS idx_compliance_breaches_status
  ON public.compliance_data_breaches (status);
CREATE INDEX IF NOT EXISTS idx_compliance_breaches_severity
  ON public.compliance_data_breaches (severity);
CREATE INDEX IF NOT EXISTS idx_compliance_breaches_detected
  ON public.compliance_data_breaches (detected_at DESC);

CREATE TRIGGER compliance_data_breaches_updated_at
  BEFORE UPDATE ON public.compliance_data_breaches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Data breach affected people
CREATE TABLE IF NOT EXISTS public.compliance_data_breach_affected_people (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  breach_id             uuid NOT NULL REFERENCES public.compliance_data_breaches (id) ON DELETE CASCADE,
  person_id             uuid NOT NULL REFERENCES public.people (id) ON DELETE CASCADE,
  notified_at           timestamptz,
  notification_method   varchar(50),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_breach_affected_breach
  ON public.compliance_data_breach_affected_people (breach_id);
CREATE INDEX IF NOT EXISTS idx_compliance_breach_affected_person
  ON public.compliance_data_breach_affected_people (person_id);

-- Processing activities (GDPR Article 30 register)
CREATE TABLE IF NOT EXISTS public.compliance_processing_activities (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_name             varchar(500) NOT NULL,
  purpose                   text NOT NULL,
  legal_basis               varchar(50) NOT NULL,
  data_categories           text[] NOT NULL DEFAULT '{}',
  data_subjects             text[] NOT NULL DEFAULT '{}',
  recipients                text[],
  retention_period          text,
  security_measures         text,
  dpia_required             boolean DEFAULT false,
  dpia_conducted            boolean DEFAULT false,
  dpia_reference            text,
  third_country_transfers   boolean DEFAULT false,
  transfer_safeguards       text,
  joint_controller          boolean DEFAULT false,
  joint_controller_details  text,
  status                    varchar(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'archived', 'draft')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_processing_activities IS 'GDPR Article 30 processing activity register';

CREATE INDEX IF NOT EXISTS idx_compliance_processing_status
  ON public.compliance_processing_activities (status);

CREATE TRIGGER compliance_processing_activities_updated_at
  BEFORE UPDATE ON public.compliance_processing_activities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Cross-border data transfers
CREATE TABLE IF NOT EXISTS public.compliance_cross_border_transfers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_country     varchar(255) NOT NULL,
  destination_country_code varchar(10),
  recipient_name          varchar(500) NOT NULL,
  recipient_type          varchar(30) NOT NULL
                          CHECK (recipient_type IN ('processor', 'controller', 'joint_controller')),
  data_categories         text[] NOT NULL DEFAULT '{}',
  transfer_mechanism      varchar(100) NOT NULL,
  safeguard_reference     text,
  adequacy_decision       boolean DEFAULT false,
  scc_version             varchar(50),
  bcr_approved            boolean DEFAULT false,
  derogation_basis        text,
  risk_assessment_date    date,
  risk_level              varchar(20) CHECK (risk_level IN ('low', 'medium', 'high')),
  supplementary_measures  text,
  status                  varchar(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'terminated')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_cross_border_transfers IS 'Register of international data transfers under GDPR';

CREATE INDEX IF NOT EXISTS idx_compliance_transfers_status
  ON public.compliance_cross_border_transfers (status);

CREATE TRIGGER compliance_cross_border_transfers_updated_at
  BEFORE UPDATE ON public.compliance_cross_border_transfers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.compliance_consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_data_breaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_data_breach_affected_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_processing_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_cross_border_transfers ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users (admin only for compliance data)
CREATE POLICY "compliance_consent_select" ON public.compliance_consent_records FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_privacy_select" ON public.compliance_privacy_requests FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_breaches_select" ON public.compliance_data_breaches FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_breach_affected_select" ON public.compliance_data_breach_affected_people FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_processing_select" ON public.compliance_processing_activities FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_transfers_select" ON public.compliance_cross_border_transfers FOR SELECT TO authenticated USING (public.is_admin());

-- Anonymous visitors can record consent (cookie consent, GDPR)
CREATE POLICY "compliance_consent_insert_anon" ON public.compliance_consent_records FOR INSERT TO anon WITH CHECK (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "compliance_consent_insert" ON public.compliance_consent_records FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_consent_update" ON public.compliance_consent_records FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_consent_delete" ON public.compliance_consent_records FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "compliance_privacy_insert" ON public.compliance_privacy_requests FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_privacy_update" ON public.compliance_privacy_requests FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_privacy_delete" ON public.compliance_privacy_requests FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "compliance_breaches_insert" ON public.compliance_data_breaches FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_breaches_update" ON public.compliance_data_breaches FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_breaches_delete" ON public.compliance_data_breaches FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "compliance_breach_affected_insert" ON public.compliance_data_breach_affected_people FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_breach_affected_delete" ON public.compliance_data_breach_affected_people FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "compliance_processing_insert" ON public.compliance_processing_activities FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_processing_update" ON public.compliance_processing_activities FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_processing_delete" ON public.compliance_processing_activities FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "compliance_transfers_insert" ON public.compliance_cross_border_transfers FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "compliance_transfers_update" ON public.compliance_cross_border_transfers FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "compliance_transfers_delete" ON public.compliance_cross_border_transfers FOR DELETE TO authenticated USING (public.is_admin());
