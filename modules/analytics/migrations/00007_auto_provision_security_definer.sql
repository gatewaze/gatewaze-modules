-- ============================================================================
-- Migration: analytics_00007_auto_provision_security_definer
-- Description: Make the sites→analytics_properties auto-provision trigger
--              run as SECURITY DEFINER. Without this, the trigger fires
--              under the inserting user's role; that role typically can't
--              INSERT into analytics_properties (RLS blocks it), so the
--              entire `INSERT INTO sites ...` call rolls back with
--              "new row violates row-level security policy for table
--              analytics_properties".
--
-- The trigger is platform-internal — it must run with the same authority
-- as the platform's service-role client, regardless of who triggered it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_analytics_auto_provision_for_site()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_initial_domain text;
BEGIN
  -- Defensive: only fire when the sites table exists (analytics module
  -- might be installed before sites; the trigger is reattached when
  -- sites lands).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sites'
  ) THEN
    RETURN NEW;
  END IF;

  v_initial_domain := COALESCE(NEW.slug, 'unspecified');

  INSERT INTO public.analytics_properties (kind, name, host_kind, host_id, domains, status)
  VALUES ('gatewaze_site', NEW.name, 'site', NEW.id, ARRAY[v_initial_domain]::text[], 'pending')
  ON CONFLICT (kind, host_kind, host_id) WHERE kind IN ('gatewaze_site', 'gatewaze_host')
  DO NOTHING;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.trg_analytics_auto_provision_for_site() IS
  'SECURITY DEFINER — runs with the function owner''s privileges so RLS on analytics_properties does not block site inserts by ordinary users.';
