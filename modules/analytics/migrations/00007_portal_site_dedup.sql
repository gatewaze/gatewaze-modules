-- ============================================================================
-- Migration: analytics_00007_portal_site_dedup
-- Description: Stop auto-provisioning a `gatewaze_site` property for the
--              seeded "Portal" site (sites migration 011), and remove any
--              duplicate that was already created.
--
-- Background: analytics_00006 provisions a property for EVERY `sites` row
-- (trigger + backfill), but the platform portal already has its own
-- singleton property (kind='portal', created at module install per
-- spec-analytics-module §8.1). The seeded Portal site row therefore
-- produced a second "Portal" entry in the property list that never
-- receives traffic — the portal app tracks into the singleton, and the
-- sites renderer never renders the metadata-only Portal site.
--
-- The seeded portal site is identified by slug = 'portal' (a reserved
-- slug per sites_011) AND publishing_target->>'kind' = 'portal' — the
-- same compound test the sites admin uses. publishing_target alone is
-- NOT distinctive: admin-created custom sites also default to
-- {kind:'portal'} (it means "published under the portal host").
--
-- Idempotent: CREATE OR REPLACE + DELETE with a WHERE that matches nothing
-- on re-run. On fresh installs where sites lands before analytics, 00006's
-- backfill still creates the duplicate and this migration immediately
-- removes it; where analytics lands first, the fixed trigger never creates
-- it. FK cascades clean up per-property rows (tracking scripts, secrets);
-- the duplicate has never collected data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Recreate the auto-provision trigger function with a portal-site skip.
-- ----------------------------------------------------------------------------

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

  -- The seeded Portal site (reserved slug 'portal' with a portal
  -- publishing target) is a metadata-only stand-in for the platform
  -- portal, which already has its own singleton property (kind='portal',
  -- seeded in 00006 §4). Provisioning a gatewaze_site property for it
  -- would duplicate that singleton in the property list. NB: the slug
  -- check is required — custom sites also default to a portal-kind
  -- publishing target.
  IF NEW.slug = 'portal' AND NEW.publishing_target->>'kind' = 'portal' THEN
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
  'SECURITY DEFINER — runs with the function owner''s privileges so RLS on analytics_properties does not block site inserts by ordinary users. Skips the seeded portal site (slug ''portal'' + portal publishing target) — the platform portal has its own singleton property.';

-- ----------------------------------------------------------------------------
-- 2. Remove the duplicate property already provisioned for the Portal site.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sites') THEN
    DELETE FROM public.analytics_properties p
    USING public.sites s
    WHERE p.kind = 'gatewaze_site'
      AND p.host_kind = 'site'
      AND p.host_id = s.id
      AND s.slug = 'portal'
      AND s.publishing_target->>'kind' = 'portal';
  END IF;
END $$;
