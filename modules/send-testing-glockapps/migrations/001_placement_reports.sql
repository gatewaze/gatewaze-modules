-- ============================================================================
-- Module: send-testing-glockapps
-- Migration: 001_placement_reports
-- Description: Per-provider inbox-placement results for a send-test run, plus
-- the seed list this add-on can optionally keep separate from the main test
-- population.
--
-- Placement answers a different question from completion, so it lives in its
-- own table attached to the core run rather than being folded into the run's
-- metrics blob: it arrives later (seed mailboxes take time to classify), it can
-- be entered by hand when the API tier does not allow reads, and it must be
-- absent-not-zero when this add-on is not installed.
--
-- See spec-send-testing-module.md §5.
-- ============================================================================

-- 1. Optional placement-only seed list ---------------------------------------
-- Seeded regardless of mode so switching to 'separate' later needs no new
-- migration. Unused in shared mode.
INSERT INTO public.lists (id, slug, name, description, is_active, is_public, is_internal, default_subscribed)
VALUES (
  '5e4d0000-0000-0000-0000-000000000002',
  'send-testing-seeds',
  'Placement Seed Addresses',
  'GlockApps seed mailboxes for inbox-placement testing. Real third-party mailboxes, not synthetic addresses.',
  true,
  false,
  true,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- 2. Placement reports --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.send_test_placement_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.send_test_runs(id) ON DELETE CASCADE,

  -- The GlockApps-side test this row came from. Null in manual mode.
  glockapps_test_id text,

  -- 'gmail' | 'outlook' | 'yahoo' | ... plus the rolled-up 'overall'.
  provider          text NOT NULL,

  inbox             integer NOT NULL DEFAULT 0,
  tabs              integer NOT NULL DEFAULT 0,
  spam              integer NOT NULL DEFAULT 0,
  missing           integer NOT NULL DEFAULT 0,

  -- API results overwrite manual ones for the same (run, provider): the manual
  -- form exists as a fallback, never as a competing source of truth.
  entered_via       text NOT NULL DEFAULT 'manual'
                    CHECK (entered_via IN ('api', 'manual')),

  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_send_test_placement_run_provider
  ON public.send_test_placement_reports (run_id, provider);
CREATE INDEX IF NOT EXISTS idx_send_test_placement_run
  ON public.send_test_placement_reports (run_id);

-- 3. Per-run GlockApps test linkage -------------------------------------------
-- Which GlockApps test backs a run, and whether polling is still worthwhile.
CREATE TABLE IF NOT EXISTS public.send_test_placement_tests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL UNIQUE REFERENCES public.send_test_runs(id) ON DELETE CASCADE,
  glockapps_test_id text NOT NULL,
  state             text NOT NULL DEFAULT 'polling'
                    CHECK (state IN ('polling', 'complete', 'stopped', 'failed')),
  last_error        text,
  last_polled_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_send_test_placement_tests_state
  ON public.send_test_placement_tests (state) WHERE state = 'polling';

-- 4. updated_at triggers -------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'send_test_placement_reports_updated_at') THEN
    CREATE TRIGGER send_test_placement_reports_updated_at
      BEFORE UPDATE ON public.send_test_placement_reports
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'send_test_placement_tests_updated_at') THEN
    CREATE TRIGGER send_test_placement_tests_updated_at
      BEFORE UPDATE ON public.send_test_placement_tests
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- 5. RLS ------------------------------------------------------------------------
ALTER TABLE public.send_test_placement_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_test_placement_tests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_test_placement_reports' AND policyname = 'auth_all_send_test_placement_reports') THEN
    CREATE POLICY "auth_all_send_test_placement_reports" ON public.send_test_placement_reports FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_test_placement_tests' AND policyname = 'auth_all_send_test_placement_tests') THEN
    CREATE POLICY "auth_all_send_test_placement_tests" ON public.send_test_placement_tests FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.send_test_placement_reports IS
  'Per-provider inbox/tabs/spam placement for a send-test run. API results overwrite manual entry for the same (run_id, provider).';
COMMENT ON TABLE public.send_test_placement_tests IS
  'Links a send-test run to its GlockApps test and tracks whether polling is still active.';
