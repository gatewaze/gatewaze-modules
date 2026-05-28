-- ============================================================================
-- Module: segments
-- Migration: 001_segments_tables
-- Description: Create segmentation tables for dynamic/manual audience segments
-- ============================================================================

-- Segments
CREATE TABLE IF NOT EXISTS public.segments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    varchar(500) NOT NULL,
  description             text,
  definition              jsonb NOT NULL DEFAULT '{}'::jsonb,
  type                    varchar(20) NOT NULL DEFAULT 'dynamic'
                          CHECK (type IN ('manual', 'dynamic', 'static')),
  status                  varchar(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'inactive', 'archived')),
  cio_segment_id          integer,
  external_id             text,
  account_id              uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  created_by              uuid,
  cached_count            integer NOT NULL DEFAULT 0,
  last_calculated_at      timestamptz,
  calculation_duration_ms integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.segments IS 'Audience segments with dynamic rule-based or manual membership';

CREATE INDEX IF NOT EXISTS idx_segments_status     ON public.segments (status);
CREATE INDEX IF NOT EXISTS idx_segments_type       ON public.segments (type);
CREATE INDEX IF NOT EXISTS idx_segments_account    ON public.segments (account_id);

CREATE TRIGGER segments_updated_at
  BEFORE UPDATE ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Segment memberships
CREATE TABLE IF NOT EXISTS public.segments_memberships (
  id                serial PRIMARY KEY,
  segment_id        uuid NOT NULL REFERENCES public.segments (id) ON DELETE CASCADE,
  person_id         uuid NOT NULL REFERENCES public.people (id) ON DELETE CASCADE,
  joined_at         timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz NOT NULL DEFAULT now(),
  added_by          uuid,
  source            varchar(20) NOT NULL DEFAULT 'calculated'
                    CHECK (source IN ('calculated', 'manual', 'import')),
  UNIQUE (segment_id, person_id)
);

COMMENT ON TABLE public.segments_memberships IS 'Tracks which people belong to which segments';

CREATE INDEX IF NOT EXISTS idx_segments_memberships_segment
  ON public.segments_memberships (segment_id);
CREATE INDEX IF NOT EXISTS idx_segments_memberships_person
  ON public.segments_memberships (person_id);

-- Segment calculation history
CREATE TABLE IF NOT EXISTS public.segments_calculation_history (
  id                      serial PRIMARY KEY,
  segment_id              uuid NOT NULL REFERENCES public.segments (id) ON DELETE CASCADE,
  calculated_at           timestamptz NOT NULL DEFAULT now(),
  member_count            integer NOT NULL DEFAULT 0,
  calculation_duration_ms integer,
  triggered_by            text,
  error                   text
);

CREATE INDEX IF NOT EXISTS idx_segments_calc_history_segment
  ON public.segments_calculation_history (segment_id);
CREATE INDEX IF NOT EXISTS idx_segments_calc_history_date
  ON public.segments_calculation_history (calculated_at DESC);

-- Segment definitions (synced from Customer.io)
CREATE TABLE IF NOT EXISTS public.segments_definitions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cio_segment_id    integer NOT NULL UNIQUE,
  name              varchar(500) NOT NULL,
  description       text,
  member_count      integer NOT NULL DEFAULT 0,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.segments_definitions IS 'Customer.io segments synced for local reference';

CREATE INDEX IF NOT EXISTS idx_segments_definitions_cio_id
  ON public.segments_definitions (cio_segment_id);
CREATE INDEX IF NOT EXISTS idx_segments_definitions_name
  ON public.segments_definitions (name);

CREATE TRIGGER segments_definitions_updated_at
  BEFORE UPDATE ON public.segments_definitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Segment people memberships (CIO segment member tracking)
CREATE TABLE IF NOT EXISTS public.segments_people_memberships (
  id                serial PRIMARY KEY,
  cio_segment_id    integer NOT NULL,
  customer_cio_id   text NOT NULL,
  joined_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cio_segment_id, customer_cio_id)
);

CREATE INDEX IF NOT EXISTS idx_segments_people_memberships_segment
  ON public.segments_people_memberships (cio_segment_id);
CREATE INDEX IF NOT EXISTS idx_segments_people_memberships_customer
  ON public.segments_people_memberships (customer_cio_id);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_calculation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_people_memberships ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "segments_select" ON public.segments FOR SELECT TO authenticated USING (true);
CREATE POLICY "segments_memberships_select" ON public.segments_memberships FOR SELECT TO authenticated USING (true);
CREATE POLICY "segments_calc_history_select" ON public.segments_calculation_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "segments_definitions_select" ON public.segments_definitions FOR SELECT TO authenticated USING (true);
CREATE POLICY "segments_people_memberships_select" ON public.segments_people_memberships FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "segments_insert" ON public.segments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "segments_update" ON public.segments FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "segments_delete" ON public.segments FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "segments_memberships_insert" ON public.segments_memberships FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "segments_memberships_update" ON public.segments_memberships FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "segments_memberships_delete" ON public.segments_memberships FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "segments_calc_history_insert" ON public.segments_calculation_history FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "segments_calc_history_delete" ON public.segments_calculation_history FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "segments_definitions_insert" ON public.segments_definitions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "segments_definitions_update" ON public.segments_definitions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "segments_definitions_delete" ON public.segments_definitions FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "segments_people_memberships_insert" ON public.segments_people_memberships FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "segments_people_memberships_delete" ON public.segments_people_memberships FOR DELETE TO authenticated USING (public.is_admin());
