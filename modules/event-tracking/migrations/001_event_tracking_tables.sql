-- ============================================================================
-- Module: event-tracking
-- Migration: 001_event_tracking_tables
-- Description: Tables for ad click tracking, UTM attribution, and conversion
--              logging across ad platforms.
-- ============================================================================

-- ==========================================================================
-- 1. integrations_ad_tracking_sessions - Ad click tracking sessions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.integrations_ad_tracking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
  click_ids jsonb,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  ip_address text,
  user_agent text,
  landing_page text,
  referrer text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'expired')),
  matched_registration_id uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  matched_via text,
  conversions_sent jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_tracking_sessions_session ON public.integrations_ad_tracking_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_integrations_tracking_sessions_event ON public.integrations_ad_tracking_sessions (event_id);

CREATE TRIGGER integrations_tracking_sessions_updated_at
  BEFORE UPDATE ON public.integrations_ad_tracking_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. integrations_conversion_log - Conversion event log for ad platforms
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.integrations_conversion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_session_id uuid REFERENCES public.integrations_ad_tracking_sessions(id) ON DELETE SET NULL,
  registration_id uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
  platform text NOT NULL,
  event_name text NOT NULL,
  dedup_event_id text,
  request_payload jsonb,
  request_url text,
  response_payload jsonb,
  http_status integer,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'success', 'failed', 'error')),
  error_message text,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_conversion_log_session ON public.integrations_conversion_log (tracking_session_id);
CREATE INDEX IF NOT EXISTS idx_integrations_conversion_log_event ON public.integrations_conversion_log (event_id);
CREATE INDEX IF NOT EXISTS idx_integrations_conversion_log_platform ON public.integrations_conversion_log (platform);

-- ==========================================================================
-- 3. RLS Policies
-- ==========================================================================

ALTER TABLE public.integrations_ad_tracking_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_integrations_ad_tracking_sessions"
  ON public.integrations_ad_tracking_sessions FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Portal creates/updates tracking sessions for anonymous visitors (ad attribution)
CREATE POLICY "ad_tracking_sessions_insert_anon"
  ON public.integrations_ad_tracking_sessions FOR INSERT TO anon
  WITH CHECK (true);
CREATE POLICY "ad_tracking_sessions_update_anon"
  ON public.integrations_ad_tracking_sessions FOR UPDATE TO anon
  USING (true);

ALTER TABLE public.integrations_conversion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all_integrations_conversion_log"
  ON public.integrations_conversion_log FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
