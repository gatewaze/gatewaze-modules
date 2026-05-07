-- ============================================================================
-- Migration: analytics_00003_tracking_scripts
-- Description: Per-property script_head + script_body blobs. Modeled on the
--              portal's existing platform_settings.tracking_head /
--              tracking_body keys (same no-sanitisation contract; see
--              spec-analytics-module §14.2). Used for Segment, GTM,
--              Hotjar, LinkedIn Insight, etc. — anything the operator
--              wants to inject.
--
--              The contract: write access gated to admins (same
--              can_admin_* check as analytics_properties); read access
--              gated to service_role (the renderer's same-process
--              lookup). Authenticated reads never see the raw blobs;
--              the admin UI surfaces them through a write-side preview
--              path, not by SELECTing them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_tracking_scripts (
  property_id   uuid PRIMARY KEY REFERENCES public.analytics_properties(property_id) ON DELETE CASCADE,
  -- Raw HTML/JS injected before </head>. Per spec §14.2: NOT sanitised.
  -- The admin-role write boundary IS the security contract.
  script_head   text,
  -- Raw HTML/JS injected before </body>.
  script_body   text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

COMMENT ON TABLE public.analytics_tracking_scripts IS
  'Per-property tracking-script blobs (Segment, GTM, etc.). NOT sanitised by design — admin-role boundary IS the security contract. Read access is service_role only; the renderer fetches at request time.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'analytics_tracking_scripts_updated_at') THEN
    CREATE TRIGGER analytics_tracking_scripts_updated_at
      BEFORE UPDATE ON public.analytics_tracking_scripts
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.analytics_tracking_scripts ENABLE ROW LEVEL SECURITY;

-- SELECT: service_role only. The renderer reads via its same-process
-- service-role connection; the admin UI uses the write-side preview path.
DROP POLICY IF EXISTS analytics_tracking_scripts_select ON public.analytics_tracking_scripts;
CREATE POLICY analytics_tracking_scripts_select ON public.analytics_tracking_scripts
  FOR SELECT
  USING (current_setting('role', true) IN ('service_role', 'postgres'));

-- WRITE: matches parent property's can_admin.
DROP POLICY IF EXISTS analytics_tracking_scripts_write ON public.analytics_tracking_scripts;
CREATE POLICY analytics_tracking_scripts_write ON public.analytics_tracking_scripts
  FOR ALL
  USING (public.can_admin_analytics_property(property_id))
  WITH CHECK (public.can_admin_analytics_property(property_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_tracking_scripts TO authenticated;
GRANT ALL ON public.analytics_tracking_scripts TO service_role;
