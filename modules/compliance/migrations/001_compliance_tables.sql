-- Compliance Module: Core Tables
-- Migration: 001_compliance_tables.sql

-- 1. Consent records
CREATE TABLE IF NOT EXISTS public.module_compliance_consent (
  id bigserial PRIMARY KEY,
  subject_email text NOT NULL,
  consent_type text NOT NULL, -- marketing, analytics, third_party
  status text NOT NULL DEFAULT 'granted', -- granted, revoked
  source text,
  granted_at timestamptz DEFAULT now(),
  revoked_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_module_compliance_consent_email ON public.module_compliance_consent(subject_email);
CREATE INDEX IF NOT EXISTS idx_module_compliance_consent_type ON public.module_compliance_consent(consent_type);

-- 2. Privacy requests (GDPR/CCPA)
CREATE TABLE IF NOT EXISTS public.module_compliance_privacy_requests (
  id bigserial PRIMARY KEY,
  subject_email text NOT NULL,
  request_type text NOT NULL, -- access, deletion, portability, rectification
  status text NOT NULL DEFAULT 'pending', -- pending, processing, completed, denied
  notes text,
  requested_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_module_compliance_privacy_email ON public.module_compliance_privacy_requests(subject_email);

-- 3. Data breach records
CREATE TABLE IF NOT EXISTS public.module_compliance_breaches (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'low', -- low, medium, high, critical
  affected_count integer DEFAULT 0,
  reported_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb
);

-- 4. Audit log
CREATE TABLE IF NOT EXISTS public.module_compliance_audit_log (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  details jsonb DEFAULT '{}'::jsonb,
  recorded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_compliance_audit_actor ON public.module_compliance_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_module_compliance_audit_time ON public.module_compliance_audit_log(recorded_at DESC);

-- 5. RLS
ALTER TABLE public.module_compliance_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_compliance_privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_compliance_breaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_compliance_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_compliance_consent" ON public.module_compliance_consent FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_compliance_privacy_requests" ON public.module_compliance_privacy_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_compliance_breaches" ON public.module_compliance_breaches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_compliance_audit_log" ON public.module_compliance_audit_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
