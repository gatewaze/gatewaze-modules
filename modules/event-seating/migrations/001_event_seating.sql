-- ============================================================================
-- Module: event-seating
-- Migration: 001_event_seating
-- Description: Seating plans for an event or sub-event. A plan is a canvas of
--              tables; each table exposes numbered seats whose positions are
--              derived from the table's shape, size and seat count. Guests are
--              assigned to a specific (table, seat_index).
--
--              Guests come from the event-invites module
--              (invite_party_members, filtered by RSVP status on
--              invite_party_member_events). A seat may instead hold a free-text
--              label so non-invited attendees (suppliers, band, late additions)
--              can be placed without an invite record.
--
-- Depends on: gatewaze core (events, storage), event-invites
--             (invite_sub_events, invite_party_members), and core
--             00024_tenancy_v2_helpers.sql for tenancy_v2_enforced(),
--             account_in_scope() and is_super_admin().
-- ============================================================================

-- ==========================================================================
-- 1. seating_plans — one canvas per event (optionally per sub-event)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.seating_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  sub_event_id uuid REFERENCES public.invite_sub_events(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Abstract canvas units. Display scales this to the available width; the
  -- background image is stretched to the same box, so tables keep their
  -- position relative to the floor plan at any zoom level.
  canvas_width integer NOT NULL DEFAULT 1400 CHECK (canvas_width BETWEEN 200 AND 20000),
  canvas_height integer NOT NULL DEFAULT 900 CHECK (canvas_height BETWEEN 200 AND 20000),
  grid_size integer NOT NULL DEFAULT 20 CHECK (grid_size BETWEEN 0 AND 500),
  snap_to_grid boolean NOT NULL DEFAULT true,
  background_asset_id uuid,
  background_hidden boolean NOT NULL DEFAULT false,
  -- Which RSVP statuses feed the unseated tray. Kept on the plan so a
  -- provisional plan can include 'pending' without changing the module config.
  guest_statuses text[] NOT NULL DEFAULT ARRAY['accepted']::text[],
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seating_plans_event ON public.seating_plans(event_id);
CREATE INDEX IF NOT EXISTS idx_seating_plans_sub_event ON public.seating_plans(sub_event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'seating_plans_updated_at') THEN
    CREATE TRIGGER seating_plans_updated_at
      BEFORE UPDATE ON public.seating_plans
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

COMMENT ON TABLE public.seating_plans IS 'A seating canvas for an event or sub-event';

-- ==========================================================================
-- 2. seating_tables — a table (or bench/sofa) placed on the canvas
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.seating_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.seating_plans(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Table',
  shape text NOT NULL DEFAULT 'round' CHECK (shape IN ('round', 'rect')),
  -- 'around'      — seats spread evenly round the whole perimeter
  -- 'both_sides'  — rectangles seated on the two long sides only
  -- 'one_side'    — top table: seats along one long side, all facing the room
  seat_layout text NOT NULL DEFAULT 'around'
    CHECK (seat_layout IN ('around', 'both_sides', 'one_side')),
  seat_count integer NOT NULL DEFAULT 8 CHECK (seat_count BETWEEN 0 AND 40),
  -- Centre point, in canvas units.
  x numeric NOT NULL DEFAULT 0,
  y numeric NOT NULL DEFAULT 0,
  -- Round tables use `width` as the diameter and ignore `height`.
  width numeric NOT NULL DEFAULT 180 CHECK (width > 0),
  height numeric NOT NULL DEFAULT 180 CHECK (height > 0),
  rotation numeric NOT NULL DEFAULT 0,
  colour text,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seating_tables_plan ON public.seating_tables(plan_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'seating_tables_updated_at') THEN
    CREATE TRIGGER seating_tables_updated_at
      BEFORE UPDATE ON public.seating_tables
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

COMMENT ON TABLE public.seating_tables IS 'A table placed on a seating plan; seat positions are derived from shape, size, seat_count and rotation';

-- ==========================================================================
-- 3. seating_assignments — one guest in one seat
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.seating_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.seating_plans(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES public.seating_tables(id) ON DELETE CASCADE,
  seat_index integer NOT NULL CHECK (seat_index >= 0),
  -- Either an invited guest, or a free-text occupant (band, photographer).
  party_member_id uuid REFERENCES public.invite_party_members(id) ON DELETE CASCADE,
  guest_label text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seating_assignments_occupant_present CHECK (
    party_member_id IS NOT NULL OR nullif(btrim(coalesce(guest_label, '')), '') IS NOT NULL
  )
);

-- One occupant per seat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seating_assignments_seat
  ON public.seating_assignments(table_id, seat_index);

-- An invited guest appears at most once per plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seating_assignments_member_per_plan
  ON public.seating_assignments(plan_id, party_member_id)
  WHERE party_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seating_assignments_plan ON public.seating_assignments(plan_id);
CREATE INDEX IF NOT EXISTS idx_seating_assignments_table ON public.seating_assignments(table_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'seating_assignments_updated_at') THEN
    CREATE TRIGGER seating_assignments_updated_at
      BEFORE UPDATE ON public.seating_assignments
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

COMMENT ON TABLE public.seating_assignments IS 'Places one guest (invited member or free-text label) in one seat of one table';

-- ==========================================================================
-- 4. seating_assets — venue floor plan backgrounds
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.seating_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  filename text NOT NULL,
  storage_path text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'event-seating',
  mime_type text,
  file_size integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seating_assets_event ON public.seating_assets(event_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'seating_plans_background_asset_id_fkey'
  ) THEN
    ALTER TABLE public.seating_plans
      ADD CONSTRAINT seating_plans_background_asset_id_fkey
      FOREIGN KEY (background_asset_id)
      REFERENCES public.seating_assets(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('event-seating', 'event-seating', true)
ON CONFLICT (id) DO NOTHING;

-- ==========================================================================
-- 5. Per-table roster view — the guest list for each table, in seat order
-- ==========================================================================
CREATE OR REPLACE VIEW public.seating_plan_roster AS
SELECT
  t.plan_id,
  t.id AS table_id,
  t.label AS table_label,
  t.seat_count,
  t.sort_order,
  a.id AS assignment_id,
  a.seat_index,
  a.party_member_id,
  COALESCE(
    a.guest_label,
    btrim(concat_ws(' ', pm.first_name, pm.last_name))
  ) AS guest_name,
  pm.party_id,
  p.name AS party_name,
  pm.is_plus_one
FROM public.seating_tables t
LEFT JOIN public.seating_assignments a ON a.table_id = t.id
LEFT JOIN public.invite_party_members pm ON pm.id = a.party_member_id
LEFT JOIN public.invite_parties p ON p.id = pm.party_id;

COMMENT ON VIEW public.seating_plan_roster IS 'Flattened per-table guest list for a seating plan, in seat order';

-- ==========================================================================
-- 6. RLS — dual-track v1/v2, scoped through the parent event's account
-- ==========================================================================
ALTER TABLE public.seating_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seating_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seating_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seating_assets ENABLE ROW LEVEL SECURITY;

-- ---- seating_plans (event_id is on the row) ------------------------------
DROP POLICY IF EXISTS "seating_plans_auth_v1" ON public.seating_plans;
CREATE POLICY "seating_plans_auth_v1"
  ON public.seating_plans FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

DROP POLICY IF EXISTS "seating_plans_all_v2" ON public.seating_plans;
CREATE POLICY "seating_plans_all_v2"
  ON public.seating_plans FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = seating_plans.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = seating_plans.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- ---- seating_tables (scope via plan → event) -----------------------------
DROP POLICY IF EXISTS "seating_tables_auth_v1" ON public.seating_tables;
CREATE POLICY "seating_tables_auth_v1"
  ON public.seating_tables FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

DROP POLICY IF EXISTS "seating_tables_all_v2" ON public.seating_tables;
CREATE POLICY "seating_tables_all_v2"
  ON public.seating_tables FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.seating_plans sp
        JOIN public.events e ON e.id = sp.event_id
        WHERE sp.id = seating_tables.plan_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.seating_plans sp
        JOIN public.events e ON e.id = sp.event_id
        WHERE sp.id = seating_tables.plan_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- ---- seating_assignments (scope via plan → event) ------------------------
DROP POLICY IF EXISTS "seating_assignments_auth_v1" ON public.seating_assignments;
CREATE POLICY "seating_assignments_auth_v1"
  ON public.seating_assignments FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

DROP POLICY IF EXISTS "seating_assignments_all_v2" ON public.seating_assignments;
CREATE POLICY "seating_assignments_all_v2"
  ON public.seating_assignments FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.seating_plans sp
        JOIN public.events e ON e.id = sp.event_id
        WHERE sp.id = seating_assignments.plan_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.seating_plans sp
        JOIN public.events e ON e.id = sp.event_id
        WHERE sp.id = seating_assignments.plan_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- ---- seating_assets (event_id is on the row) -----------------------------
DROP POLICY IF EXISTS "seating_assets_auth_v1" ON public.seating_assets;
CREATE POLICY "seating_assets_auth_v1"
  ON public.seating_assets FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

DROP POLICY IF EXISTS "seating_assets_all_v2" ON public.seating_assets;
CREATE POLICY "seating_assets_all_v2"
  ON public.seating_assets FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = seating_assets.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = seating_assets.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- The roster view is read through the base tables' policies.
ALTER VIEW public.seating_plan_roster SET (security_invoker = true);
