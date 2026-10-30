-- ============================================================================
-- Module: event-tracking
-- Migration: 002_tracking_session_attribution_columns
-- Description: Columns the portal redirect (/e/[identifier]), the portal
--              tracking-session API and the ad-conversions senders already
--              write and read on integrations_ad_tracking_sessions, but which
--              001 never created. Without them every session insert on a fresh
--              install fails and no conversion can ever be matched.
--              Also replaces the open 001 policies: browsers may insert a
--              session and set two columns on it; only admins may read
--              sessions or the conversion log.
-- ============================================================================

ALTER TABLE public.integrations_ad_tracking_sessions
  ADD COLUMN IF NOT EXISTS brand_id             text,
  ADD COLUMN IF NOT EXISTS platform_cookies     jsonb        NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS email_hash           text,
  ADD COLUMN IF NOT EXISTS tracking_consent     boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_timestamp    timestamptz,
  ADD COLUMN IF NOT EXISTS consented_platforms  text[]       NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS external_redirect_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at           timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS matched_at           timestamptz;

COMMENT ON COLUMN public.integrations_ad_tracking_sessions.email_hash IS
  'SHA-256 of the lower-cased, trimmed email, when the visitor identified themselves before redirecting. Used for tier-2 conversion matching.';
COMMENT ON COLUMN public.integrations_ad_tracking_sessions.external_redirect_at IS
  'Set when the session was redirected to an external registration page (Luma). Tier-3 timing matches skip these: the session id travelled in the URL, so a registration without it is a different person.';
COMMENT ON COLUMN public.integrations_ad_tracking_sessions.consented_platforms IS
  'Platforms the visitor consented to share conversion data with. Empty means no marketing consent; senders then use the hashed email only.';

CREATE INDEX IF NOT EXISTS idx_integrations_tracking_sessions_email_event
  ON public.integrations_ad_tracking_sessions (email_hash, event_id)
  WHERE email_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integrations_tracking_sessions_event_created
  ON public.integrations_ad_tracking_sessions (event_id, created_at DESC)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Access. The portal (anon, or authenticated for a signed-in member) inserts
-- a session and later sets external_redirect_at / email_hash on it by
-- session_id. Nothing in a browser may read IPs, cookies or click ids, or
-- rewrite status / matched_* / conversions_sent (those decide attribution).
-- Admins read everything through the authenticated role (admin UI); the
-- edge functions use the service role, which bypasses RLS.
-- Supabase grants the whole table to anon and authenticated by default, so
-- table-level REVOKE then column-level GRANT (a bare column REVOKE is a no-op).
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.integrations_ad_tracking_sessions FROM anon, authenticated;

GRANT INSERT (
    session_id, brand_id, event_id, click_ids, platform_cookies,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, landing_page, user_agent, ip_address, email_hash,
    tracking_consent, consent_timestamp, consented_platforms,
    expires_at, external_redirect_at
  ) ON public.integrations_ad_tracking_sessions TO anon, authenticated;

-- The two columns the portal sets after insert. updated_at is set by the
-- row trigger, which is not privilege-checked, but is listed for clarity.
GRANT UPDATE (external_redirect_at, email_hash, updated_at)
  ON public.integrations_ad_tracking_sessions TO anon, authenticated;

-- An UPDATE ... WHERE session_id = $1 needs SELECT on the columns it
-- references and a SELECT policy, or it silently matches no rows. Limit the
-- browser roles to the identifiers only. Admins get every column.
GRANT SELECT (id, session_id, event_id) ON public.integrations_ad_tracking_sessions TO anon;
GRANT SELECT ON public.integrations_ad_tracking_sessions TO authenticated;

DROP POLICY IF EXISTS "authenticated_all_integrations_ad_tracking_sessions" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_insert_anon" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_update_anon" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_select_anon" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_insert_browser" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_update_browser" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_select_admin" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_write_admin" ON public.integrations_ad_tracking_sessions;

CREATE POLICY "ad_tracking_sessions_insert_browser"
  ON public.integrations_ad_tracking_sessions FOR INSERT TO anon, authenticated
  WITH CHECK (true);
CREATE POLICY "ad_tracking_sessions_update_browser"
  ON public.integrations_ad_tracking_sessions FOR UPDATE TO anon, authenticated
  USING (true) WITH CHECK (true);
-- Row visibility for the browser UPDATE's WHERE clause; the column grant
-- above means anon sees only id / session_id / event_id.
CREATE POLICY "ad_tracking_sessions_select_anon"
  ON public.integrations_ad_tracking_sessions FOR SELECT TO anon
  USING (true);
CREATE POLICY "ad_tracking_sessions_select_admin"
  ON public.integrations_ad_tracking_sessions FOR SELECT TO authenticated
  USING (public.is_admin());

-- Conversion log: written by the edge functions (service role), read by
-- admins only. 001 let every authenticated user do anything.
REVOKE ALL ON public.integrations_conversion_log FROM anon, authenticated;
GRANT SELECT ON public.integrations_conversion_log TO authenticated;
DROP POLICY IF EXISTS "authenticated_all_integrations_conversion_log" ON public.integrations_conversion_log;
DROP POLICY IF EXISTS "integrations_conversion_log_select_admin" ON public.integrations_conversion_log;
CREATE POLICY "integrations_conversion_log_select_admin"
  ON public.integrations_conversion_log FOR SELECT TO authenticated
  USING (public.is_admin());

-- The admin Tracking tab reads the log under this name.
CREATE OR REPLACE VIEW public.integrations_conversion_events_log
  WITH (security_invoker = true) AS
  SELECT * FROM public.integrations_conversion_log;
REVOKE ALL ON public.integrations_conversion_events_log FROM anon;
GRANT SELECT ON public.integrations_conversion_events_log TO authenticated, service_role;
