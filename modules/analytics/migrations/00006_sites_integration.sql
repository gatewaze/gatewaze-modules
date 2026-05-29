-- ============================================================================
-- Migration: analytics_00006_sites_integration
-- Description: Auto-create an analytics_properties row when a site or
--              other host is created, plus a SQL helper the sites
--              renderer calls to resolve a host → property_id at
--              render time.
--
-- Per spec-analytics-module §8.1 + §11.2:
--   "Property auto-created on `sites` row insert (verified via
--    integration test). Property auto-created on `host_registry`
--    registration for non-site hosts."
--
-- The trigger is defensive: it only fires if the analytics_properties
-- table exists (because the analytics module might be installed AFTER
-- sites already has rows — the trigger then becomes a no-op until the
-- analytics module is installed, at which point a follow-up backfill
-- migration would handle the catch-up).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Trigger function — INSERT INTO analytics_properties on host insert
-- ----------------------------------------------------------------------------

-- SECURITY DEFINER (was 00007_auto_provision_security_definer): the trigger
-- is platform-internal and must INSERT into analytics_properties regardless of
-- the inserting user's role, else RLS rolls back the whole `INSERT INTO sites`.
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

DO $$
BEGIN
  -- Only attach the trigger if sites exists (the analytics module ships
  -- with its own migration order; at the time this runs, sites may or
  -- may not be present).
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sites') THEN
    DROP TRIGGER IF EXISTS analytics_auto_provision_site ON public.sites;
    CREATE TRIGGER analytics_auto_provision_site
      AFTER INSERT ON public.sites
      FOR EACH ROW EXECUTE FUNCTION public.trg_analytics_auto_provision_for_site();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Backfill — for sites that already exist when the analytics module
--    is installed (e.g. an upgrade adding analytics to an existing
--    deployment). Idempotent via the unique index on (kind, host_kind,
--    host_id).
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sites') THEN
    INSERT INTO public.analytics_properties (kind, name, host_kind, host_id, domains, status)
    SELECT 'gatewaze_site', s.name, 'site', s.id, ARRAY[COALESCE(s.slug, 'unspecified')]::text[], 'pending'
    FROM public.sites s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.analytics_properties p
      WHERE p.kind = 'gatewaze_site' AND p.host_kind = 'site' AND p.host_id = s.id
    );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Renderer-side helper — resolve a host_kind+host_id → property_id
--    Called by the sites renderer at request time. Returns NULL when no
--    property is provisioned (renderer omits the analytics snippet).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_resolve_property_for_host(
  p_host_kind text,
  p_host_id uuid
)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT property_id
  FROM public.analytics_properties
  WHERE host_kind = p_host_kind AND host_id = p_host_id AND status = 'active'
  LIMIT 1
$$;

COMMENT ON FUNCTION public.analytics_resolve_property_for_host(text, uuid) IS
  'Resolve a host (site, calendar, etc.) to its provisioned analytics property_id. Returns NULL when not provisioned. Called by the sites renderer at page-render time.';

GRANT EXECUTE ON FUNCTION public.analytics_resolve_property_for_host(text, uuid) TO authenticated, service_role, anon;

-- ----------------------------------------------------------------------------
-- 4. Auto-create the singleton 'portal' property on first install.
--    Per spec acceptance criterion: "Portal property auto-created on
--    module install."
-- ----------------------------------------------------------------------------

INSERT INTO public.analytics_properties (kind, name, domains, status)
VALUES (
  'portal',
  'Portal',
  -- Operator updates this via the admin UI after install
  ARRAY[]::text[],
  'pending'
)
ON CONFLICT (kind) WHERE kind = 'portal' DO NOTHING;
