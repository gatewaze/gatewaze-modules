-- ============================================================================
-- Module: ad-conversions
-- Migration: 001_platform_configs_and_dispatch
-- Description: Everything the three conversion edge functions call but which
--              no migration ever created on a modules-based install:
--                * ad_platform_configs (per-brand / account / event credentials)
--                * get_ad_platform_config / get_active_ad_platforms RPCs
--                * integrations_log_conversion_event /
--                  integrations_update_conversion_log_response RPCs
--                * the send_conversion_on_registration trigger that the
--                  registration edge functions have relied on by comment only.
--              The trigger posts to the integrations-send-conversion edge
--              function through pg_net. It reads the Supabase URL and the
--              service-role key from Vault (names gw_supabase_url and
--              gw_service_role_key), falling back to the app.supabase_url /
--              app.service_role_key settings. With neither present it is a
--              no-op, so the migration is safe to apply before any setup.
-- Requires: event-tracking 002 (tracking session columns), pg_net for dispatch.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Platform credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ad_platform_configs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      text,
  account_id    uuid,
  event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('meta', 'reddit', 'linkedin', 'google', 'bing', 'tiktok')),
  credentials   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  -- read/written by the admin Tracking tab (event-tracking AdPlatformSettings)
  attribution_window_days integer NOT NULL DEFAULT 7,
  event_mapping jsonb NOT NULL DEFAULT '{"registration": "Lead"}'::jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- exactly one scope per row: event, account, or brand-wide (neither)
  CONSTRAINT ad_platform_configs_one_scope CHECK (NOT (event_id IS NOT NULL AND account_id IS NOT NULL))
);

COMMENT ON TABLE public.ad_platform_configs IS
  'Ad platform Conversions API credentials. Resolution order for an event: event row, then its account row, then the brand-wide row (event_id and account_id both null). Credentials are read only through get_ad_platform_config by the service role.';
COMMENT ON COLUMN public.ad_platform_configs.credentials IS
  'meta: {pixel_id, access_token, test_event_code?}. reddit: {pixel_id, access_token, test_mode?}. linkedin: {conversion_id, access_token, purchase_conversion_id?, api_version?}.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_platform_configs_event
  ON public.ad_platform_configs (event_id, platform) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_platform_configs_account
  ON public.ad_platform_configs (account_id, platform) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_platform_configs_brand
  ON public.ad_platform_configs (coalesce(brand_id, ''), platform) WHERE event_id IS NULL AND account_id IS NULL;

DROP TRIGGER IF EXISTS ad_platform_configs_updated_at ON public.ad_platform_configs;
CREATE TRIGGER ad_platform_configs_updated_at
  BEFORE UPDATE ON public.ad_platform_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Credentials: RLS on. Admins manage rows from the admin Tracking tab
-- (authenticated role, is_admin()); the edge functions read through the
-- service role, which bypasses RLS. Nothing for anon.
ALTER TABLE public.ad_platform_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_platform_configs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_platform_configs TO authenticated;
DROP POLICY IF EXISTS "ad_platform_configs_admin_all" ON public.ad_platform_configs;
CREATE POLICY "ad_platform_configs_admin_all"
  ON public.ad_platform_configs FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Config resolution RPCs (service role only)
-- ---------------------------------------------------------------------------

-- Resolve an event reference that may be the events.id uuid or the public
-- events.event_id slug. Returns NULL when neither matches.
CREATE OR REPLACE FUNCTION public.ad_conversions_resolve_event(p_event_ref text)
RETURNS TABLE (event_uuid uuid, account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.id, e.account_id
  FROM public.events e
  WHERE (p_event_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND e.id = p_event_ref::uuid)
     OR e.event_id = p_event_ref
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_platform_config(p_event_id text, p_platform text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event uuid;
  v_account uuid;
  v_row public.ad_platform_configs%ROWTYPE;
  v_scope text;
BEGIN
  SELECT r.event_uuid, r.account_id INTO v_event, v_account
  FROM public.ad_conversions_resolve_event(p_event_id) r;

  IF v_event IS NOT NULL THEN
    SELECT * INTO v_row FROM public.ad_platform_configs
     WHERE is_active AND platform = p_platform AND event_id = v_event
     LIMIT 1;
    IF FOUND THEN v_scope := 'event'; END IF;
  END IF;

  IF v_scope IS NULL AND v_account IS NOT NULL THEN
    SELECT * INTO v_row FROM public.ad_platform_configs
     WHERE is_active AND platform = p_platform AND account_id = v_account
     LIMIT 1;
    IF FOUND THEN v_scope := 'account'; END IF;
  END IF;

  IF v_scope IS NULL THEN
    SELECT * INTO v_row FROM public.ad_platform_configs
     WHERE is_active AND platform = p_platform AND event_id IS NULL AND account_id IS NULL
     ORDER BY brand_id NULLS LAST
     LIMIT 1;
    IF FOUND THEN v_scope := 'brand'; END IF;
  END IF;

  IF v_scope IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'platform', v_row.platform,
    'scope', v_scope,
    'credentials', v_row.credentials
  );
END;
$$;

-- Platforms that have an active config reaching this event (any scope).
CREATE OR REPLACE FUNCTION public.get_active_ad_platforms(p_event_id text)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ev AS (
    SELECT r.event_uuid, r.account_id FROM public.ad_conversions_resolve_event(p_event_id) r
  )
  SELECT coalesce(array_agg(DISTINCT c.platform ORDER BY c.platform), '{}'::text[])
  FROM public.ad_platform_configs c
  LEFT JOIN ev ON true
  WHERE c.is_active
    AND (
      (c.event_id IS NOT NULL AND c.event_id = ev.event_uuid)
      OR (c.account_id IS NOT NULL AND c.account_id = ev.account_id)
      OR (c.event_id IS NULL AND c.account_id IS NULL)
    );
$$;

-- ---------------------------------------------------------------------------
-- 3. Conversion log RPCs (service role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrations_log_conversion_event(
  p_tracking_session_id uuid,
  p_registration_id     uuid,
  p_event_id            text,
  p_platform            text,
  p_event_name          text,
  p_dedup_event_id      text,
  p_request_payload     jsonb,
  p_request_url         text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_event uuid;
BEGIN
  SELECT r.event_uuid INTO v_event FROM public.ad_conversions_resolve_event(p_event_id) r;

  INSERT INTO public.integrations_conversion_log (
    tracking_session_id, registration_id, event_id, platform, event_name,
    dedup_event_id, request_payload, request_url, status, sent_at
  ) VALUES (
    p_tracking_session_id,
    -- registration_id is an FK to events_registrations; competition entries
    -- and discount codes reuse this column by id without the FK matching, so
    -- only store it when it really is a registration.
    CASE WHEN EXISTS (SELECT 1 FROM public.events_registrations WHERE id = p_registration_id) THEN p_registration_id END,
    v_event, p_platform, p_event_name,
    p_dedup_event_id, p_request_payload, p_request_url, 'sent', now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.integrations_update_conversion_log_response(
  p_log_id           uuid,
  p_http_status      integer,
  p_response_payload jsonb,
  p_success          boolean,
  p_error_message    text,
  p_error_code       text
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.integrations_conversion_log
     SET http_status      = p_http_status,
         response_payload = p_response_payload,
         status           = CASE WHEN p_success THEN 'success' ELSE 'failed' END,
         error_message    = CASE
                              WHEN p_success THEN NULL
                              WHEN p_error_code IS NOT NULL THEN p_error_code || ': ' || coalesce(p_error_message, '')
                              ELSE p_error_message
                            END,
         completed_at     = now()
   WHERE id = p_log_id;
$$;

-- Lock all four RPCs down to the service role. They are SECURITY DEFINER and
-- the first two return credentials.
REVOKE ALL ON FUNCTION public.ad_conversions_resolve_event(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_ad_platform_config(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_active_ad_platforms(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.integrations_log_conversion_event(uuid, uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.integrations_update_conversion_log_response(uuid, integer, jsonb, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ad_conversions_resolve_event(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_ad_platform_config(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_active_ad_platforms(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.integrations_log_conversion_event(uuid, uuid, text, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.integrations_update_conversion_log_response(uuid, integer, jsonb, boolean, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Dispatch trigger: every new registration asks the dispatcher to send
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ad_conversions_on_registration()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  -- A cancelled row is not a conversion. Neither is a backfilled historical
  -- registration: the ad platforms reject events older than 7 days (Meta)
  -- and attributing them would be wrong anyway.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF NEW.registered_at IS NOT NULL AND NEW.registered_at < now() - interval '7 days' THEN
    RETURN NEW;
  END IF;

  -- Vault first (Supabase cloud), then the app.* settings some self-hosted
  -- instances carry. Both values must come from the SAME source: a
  -- session-settable app.supabase_url must never be paired with the Vault
  -- key, or a SET in a SQL session could redirect the key elsewhere. Any
  -- failure reading Vault leaves the trigger a no-op.
  BEGIN
    SELECT nullif(decrypted_secret, '') INTO v_url FROM vault.decrypted_secrets WHERE name = 'gw_supabase_url' LIMIT 1;
    SELECT nullif(decrypted_secret, '') INTO v_key FROM vault.decrypted_secrets WHERE name = 'gw_service_role_key' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL;
    v_key := NULL;
  END;
  IF v_url IS NULL OR v_key IS NULL THEN
    v_url := nullif(current_setting('app.supabase_url', true), '');
    v_key := nullif(current_setting('app.service_role_key', true), '');
  END IF;

  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := rtrim(v_url, '/') || '/functions/v1/integrations-send-conversion',
      body    := jsonb_build_object('registrationId', NEW.id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      timeout_milliseconds := 15000
    );
  EXCEPTION WHEN OTHERS THEN
    -- pg_net missing, or the queue refused the row. Never block the insert.
    RAISE WARNING 'ad-conversions: dispatch not queued for registration % (%)', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ad_conversions_on_registration() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS send_conversion_on_registration ON public.events_registrations;
CREATE TRIGGER send_conversion_on_registration
  AFTER INSERT ON public.events_registrations
  FOR EACH ROW EXECUTE FUNCTION public.ad_conversions_on_registration();

COMMENT ON TRIGGER send_conversion_on_registration ON public.events_registrations IS
  'ad-conversions: queues a pg_net POST to integrations-send-conversion for each new registration. No-op until Vault holds gw_supabase_url and gw_service_role_key.';
