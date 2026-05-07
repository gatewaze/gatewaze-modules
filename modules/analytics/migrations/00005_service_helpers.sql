-- ============================================================================
-- Migration: analytics_00005_service_helpers
-- Description: SQL helpers the analyticsService calls via supabase.rpc().
--              Each is SECURITY DEFINER so the service can answer
--              auth + property-meta questions without leaking RLS state.
--
-- Per spec-analytics-module §6.1 (auth wrapper).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- analytics_property_exists — disambiguator for the auth path.
-- can_read_analytics_property returns false for both "no perms" and
-- "no such property"; this lets the service surface the right reason
-- (`property_not_found` vs `forbidden`).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_property_exists(p_property_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.analytics_properties WHERE property_id = p_property_id
  )
$$;

COMMENT ON FUNCTION public.analytics_property_exists(uuid) IS
  'Disambiguator for the auth wrapper — returns true iff the property row exists, regardless of caller perms.';

-- ----------------------------------------------------------------------------
-- analytics_property_meta — read website_uuid + status without granting
-- broad SELECT on analytics_properties to authenticated callers. Used by
-- the service to resolve property_id → Umami website_uuid after auth.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.analytics_property_meta(p_property_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT to_jsonb(t) FROM (
    SELECT website_uuid, status
    FROM public.analytics_properties
    WHERE property_id = p_property_id
  ) t
$$;

COMMENT ON FUNCTION public.analytics_property_meta(uuid) IS
  'Returns {website_uuid, status} for a property. SECURITY DEFINER — callers gate via can_read_analytics_property first.';

-- ----------------------------------------------------------------------------
-- templates_ab_assignment_counts — used by getVariantBreakdown to count
-- per-variant assignments. Lives here (analytics module) because it's
-- analytics-specific aggregation; the templates module owns the raw
-- table and just exposes SELECT under its RLS.
-- ----------------------------------------------------------------------------

-- The templates module schema:
--   templates_ab_tests.variants is JSONB — array of { id, name, weight, ... }
--   templates_ab_assignments.variant is TEXT (the variant id or label)
-- There is NO separate templates_ab_variants table; variants live inline.
-- This helper aggregates assignment counts and pulls variant labels from
-- the JSONB. Returns text variant_id (it's a JSON string, not a uuid).
--
-- Defensive in two ways: (1) the function is created even when the
-- templates module is absent — plpgsql defers binding so the function
-- definition doesn't require the table; (2) the body checks for the
-- table at call time and returns empty if missing.
CREATE OR REPLACE FUNCTION public.templates_ab_assignment_counts(p_ab_test_id uuid)
RETURNS TABLE(variant_id text, variant_name text, count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'templates_ab_assignments'
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $sql$
    SELECT
      a.variant::text AS variant_id,
      COALESCE(v.elem->>'name', a.variant)::text AS variant_name,
      count(*)::bigint AS count
    FROM public.templates_ab_assignments a
    LEFT JOIN public.templates_ab_tests t ON t.id = a.test_id
    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(t.variants, '[]'::jsonb)) AS v(elem)
      ON v.elem->>'id' = a.variant
    WHERE a.test_id = $1
    GROUP BY a.variant, v.elem->>'name'
    ORDER BY variant_name
  $sql$ USING p_ab_test_id;
END $$;

COMMENT ON FUNCTION public.templates_ab_assignment_counts(uuid) IS
  'Per-variant assignment counts for the analytics getVariantBreakdown query. Returns empty when templates module is not installed.';

GRANT EXECUTE ON FUNCTION public.analytics_property_exists(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analytics_property_meta(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.templates_ab_assignment_counts(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Auto-enqueue trigger — insert into analytics_properties → enqueue
-- a provisioning job. Worker picks it up on the next cron tick.
-- Idempotent: if a job already exists for the property in queued/creating
-- state, we don't insert another (the trigger filters via NOT EXISTS).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_analytics_property_enqueue_provisioning()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only enqueue when:
  --   - INSERT and the row is pending (the default)
  --   - UPDATE that flipped status from non-pending → pending
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    INSERT INTO public.analytics_provisioning_jobs (property_id, status)
    SELECT NEW.property_id, 'queued'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.analytics_provisioning_jobs
      WHERE property_id = NEW.property_id AND status IN ('queued', 'creating')
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'pending' AND NEW.status = 'pending' THEN
    INSERT INTO public.analytics_provisioning_jobs (property_id, status)
    SELECT NEW.property_id, 'queued'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.analytics_provisioning_jobs
      WHERE property_id = NEW.property_id AND status IN ('queued', 'creating')
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS analytics_property_enqueue_provisioning_iud ON public.analytics_properties;
CREATE TRIGGER analytics_property_enqueue_provisioning_iud
  AFTER INSERT OR UPDATE OF status ON public.analytics_properties
  FOR EACH ROW EXECUTE FUNCTION public.trg_analytics_property_enqueue_provisioning();

COMMENT ON FUNCTION public.trg_analytics_property_enqueue_provisioning() IS
  'Auto-enqueues an analytics_provisioning_jobs row when a property enters the pending state. Idempotent — guards against duplicate queued/creating jobs for the same property.';
