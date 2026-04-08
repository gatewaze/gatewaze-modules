-- ============================================================================
-- Module: custom-domains
-- Migration: 001_custom_domains_table
-- Description: Central registry for custom domains with content assignment,
--              DNS verification status, and TLS certificate tracking.
-- ============================================================================

-- ==========================================================================
-- 1. Custom Domains registry
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.custom_domains (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The bare hostname (e.g., myconference.com, www.myevent.org)
  domain            text NOT NULL UNIQUE,
  -- Provisioning lifecycle
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending',        -- Waiting for DNS verification
                      'dns_verified',   -- DNS verified, awaiting certificate
                      'provisioning',   -- Certificate being provisioned by cert-manager
                      'active',         -- Fully active — serving traffic with TLS
                      'error',          -- Something went wrong (see error_message)
                      'removing'        -- Being decommissioned
                    )),
  error_message     text,
  -- Content assignment — what this domain serves
  -- null values mean the domain is registered but not yet assigned
  content_type      text,              -- e.g., 'event', 'blog', 'newsletter', 'recipe'
  content_id        uuid,              -- ID of the content item
  content_slug      text,              -- URL-safe slug for portal routing
  -- Infrastructure state (managed by the domain controller)
  dns_verified_at   timestamptz,
  certificate_ready boolean DEFAULT false,
  ingress_created   boolean DEFAULT false,
  -- Configuration (populated from module config on creation)
  cname_target      text,              -- e.g., 'custom.aaif.live'
  expected_ip       text,              -- e.g., '143.42.179.249'
  -- Optional branding overrides
  page_title        text,              -- Custom HTML <title>
  favicon_url       text,              -- Custom favicon URL
  -- Timestamps
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON public.custom_domains (domain);
CREATE INDEX IF NOT EXISTS idx_custom_domains_status ON public.custom_domains (status);
CREATE INDEX IF NOT EXISTS idx_custom_domains_content ON public.custom_domains (content_type, content_id);

-- ==========================================================================
-- 2. Auto-update updated_at timestamp
-- ==========================================================================
CREATE OR REPLACE FUNCTION update_custom_domains_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS custom_domains_updated_at ON public.custom_domains;
CREATE TRIGGER custom_domains_updated_at
  BEFORE UPDATE ON public.custom_domains
  FOR EACH ROW EXECUTE FUNCTION update_custom_domains_updated_at();

-- ==========================================================================
-- 3. Row-Level Security
-- ==========================================================================
ALTER TABLE public.custom_domains ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user can see domains (needed for portal lookups)
DROP POLICY IF EXISTS custom_domains_select ON public.custom_domains;
CREATE POLICY custom_domains_select ON public.custom_domains
  FOR SELECT TO authenticated USING (true);

-- Write: admin only
DROP POLICY IF EXISTS custom_domains_insert ON public.custom_domains;
CREATE POLICY custom_domains_insert ON public.custom_domains
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
  );

DROP POLICY IF EXISTS custom_domains_update ON public.custom_domains;
CREATE POLICY custom_domains_update ON public.custom_domains
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
  );

DROP POLICY IF EXISTS custom_domains_delete ON public.custom_domains;
CREATE POLICY custom_domains_delete ON public.custom_domains
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
  );

-- Service role: full access (used by domain controller)
DROP POLICY IF EXISTS custom_domains_service ON public.custom_domains;
CREATE POLICY custom_domains_service ON public.custom_domains
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Anon: read-only for portal middleware lookups (unauthenticated visitors)
DROP POLICY IF EXISTS custom_domains_anon_select ON public.custom_domains;
CREATE POLICY custom_domains_anon_select ON public.custom_domains
  FOR SELECT TO anon USING (status = 'active');
