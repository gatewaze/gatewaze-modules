-- ============================================================================
-- Migration: analytics_00008_saved_reports
-- Description: Saved report definitions (funnels first; journeys/utm later)
--              so operators can define a funnel once and track its
--              conversion over time instead of re-building it per visit.
--
-- The definition is a jsonb blob owned by the admin UI (funnel: steps[] +
-- window). Results are NOT stored — they're computed on demand against
-- Umami for whatever date range the viewer selects, so a saved funnel is
-- a lens, not a snapshot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_saved_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES public.analytics_properties (property_id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('funnel', 'journey', 'utm')),
  name          varchar(120) NOT NULL,
  definition    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.analytics_saved_reports IS
  'Saved analytics report definitions (funnel steps etc.) — computed on demand, never snapshotted';

CREATE INDEX IF NOT EXISTS idx_analytics_saved_reports_property
  ON public.analytics_saved_reports (property_id, type);

DROP TRIGGER IF EXISTS set_analytics_saved_reports_updated_at ON public.analytics_saved_reports;
CREATE TRIGGER set_analytics_saved_reports_updated_at
  BEFORE UPDATE ON public.analytics_saved_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.analytics_saved_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytics_saved_reports_select ON public.analytics_saved_reports;
CREATE POLICY analytics_saved_reports_select ON public.analytics_saved_reports
  FOR SELECT
  USING (public.can_read_analytics_property(property_id));

DROP POLICY IF EXISTS analytics_saved_reports_write ON public.analytics_saved_reports;
CREATE POLICY analytics_saved_reports_write ON public.analytics_saved_reports
  FOR ALL
  USING (public.can_admin_analytics_property(property_id))
  WITH CHECK (public.can_admin_analytics_property(property_id));
