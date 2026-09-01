-- ============================================================================
-- Module: send-testing
-- Migration: 002_send_test_runs
-- Description: Test runs, observed arrivals, and provisioning job state.
--
-- A run is an observation window. The inbound webhook inserts arrivals blind
-- (run_id NULL); attribution happens AFTER the run closes, by time window plus
-- an optional subject filter. That ordering is deliberate: a message delayed
-- past close by greylisting can never be stamped onto whichever run happens to
-- be open when it finally lands, and the webhook hot path stays a single
-- insert with no lookups.
--
-- See spec-send-testing-module.md §4.3.
-- ============================================================================

-- 1. Test runs ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.send_test_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,                            -- operator label
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'closed', 'archived')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,                              -- observation window end

  -- Snapshot of subscribed test-list membership taken when the run opened.
  -- People provisioned later do not change it: the denominator must match what
  -- the send actually targeted.
  expected_count      integer NOT NULL DEFAULT 0,

  send_source         text,                                     -- 'broadcast' | 'newsletter' | 'external' | ...
  send_ref            text,                                     -- broadcast/newsletter send id, or a free note

  -- Optional case-insensitive subject substring. When set, attribution
  -- additionally requires a subject match, which disambiguates back-to-back
  -- runs when a straggler from the previous send is still arriving.
  subject_filter      text,

  notes               text,
  attribution_status  text NOT NULL DEFAULT 'pending'
                      CHECK (attribution_status IN ('pending', 'running', 'complete', 'failed')),
  attribution_error   text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,       -- materialised metrics on close
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One run open at a time, enforced in the database rather than only in the API.
-- This is what makes time-window attribution unambiguous: run windows can
-- never overlap.
CREATE UNIQUE INDEX IF NOT EXISTS uq_send_test_runs_one_open
  ON public.send_test_runs (status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_send_test_runs_status_created
  ON public.send_test_runs (status, created_at DESC);

-- 2. Observed arrivals -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.send_test_arrivals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL on ingest. Set by the post-close attribution job.
  run_id            uuid REFERENCES public.send_test_runs(id) ON DELETE SET NULL,

  recipient_email   text NOT NULL,                              -- the st-* address, lowercased

  -- Arrival time. Normally webhook ingest time, but a SendGrid retry arrives
  -- late, so the receiver substitutes the timestamp parsed from the topmost
  -- Received header when it can, to avoid inflating measured latency.
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Always the real webhook processing time, so a corrected received_at stays
  -- auditable.
  ingested_at       timestamptz NOT NULL DEFAULT now(),

  -- Dedupe/join key. The Message-ID header when present, else a deterministic
  -- 'synth:<sha256>' fallback computed by the receiver. NOT NULL so idempotency
  -- never rests on a nullable column.
  message_id        text NOT NULL,

  subject           text,
  headers_meta      jsonb NOT NULL DEFAULT '{}'::jsonb,         -- Date, Received count, List-Unsubscribe, auth results

  -- Populated ONLY for the small inspectable sample (see §4.5a) so an operator
  -- can open a delivered message and click its real unsubscribe link. NULL for
  -- the other ~25k arrivals: bodies at that volume are bulk noise.
  body_html         text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: a SendGrid retry upserts instead of double-counting, which would
-- otherwise corrupt the completion metric.
CREATE UNIQUE INDEX IF NOT EXISTS uq_send_test_arrivals_recipient_message
  ON public.send_test_arrivals (recipient_email, message_id);
CREATE INDEX IF NOT EXISTS idx_send_test_arrivals_run
  ON public.send_test_arrivals (run_id);
CREATE INDEX IF NOT EXISTS idx_send_test_arrivals_received
  ON public.send_test_arrivals (received_at);
-- Cheap sweep for the attribution job and the "unattributed in-window" count.
CREATE INDEX IF NOT EXISTS idx_send_test_arrivals_unattributed
  ON public.send_test_arrivals (received_at) WHERE run_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_send_test_arrivals_recipient
  ON public.send_test_arrivals (recipient_email);

-- 3. Provisioning job state (singleton) ---------------------------------------
-- At most one provisioning/deprovisioning job runs at a time, so this table
-- holds a single row keyed by a fixed id. The job_id returned by the API is
-- informational (logs/telemetry); status is always "the current job".
CREATE TABLE IF NOT EXISTS public.send_test_provision_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         text NOT NULL CHECK (action IN ('provision', 'deprovision', 'resubscribe')),
  state          text NOT NULL DEFAULT 'running'
                 CHECK (state IN ('running', 'completed', 'no_change', 'failed')),
  target_count   integer,
  processed      integer NOT NULL DEFAULT 0,
  last_error     text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_send_test_provision_jobs_started
  ON public.send_test_provision_jobs (started_at DESC);
-- At most one job in flight; the API returns 409 rather than racing two
-- chunked writers over the same population.
CREATE UNIQUE INDEX IF NOT EXISTS uq_send_test_provision_jobs_running
  ON public.send_test_provision_jobs (state) WHERE state = 'running';

-- 4. updated_at triggers ------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'send_test_runs_updated_at') THEN
    CREATE TRIGGER send_test_runs_updated_at
      BEFORE UPDATE ON public.send_test_runs
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'send_test_provision_jobs_updated_at') THEN
    CREATE TRIGGER send_test_provision_jobs_updated_at
      BEFORE UPDATE ON public.send_test_provision_jobs
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- 5. RLS ----------------------------------------------------------------------
-- These tables hold recipient addresses (synthetic, but the shape is the same),
-- so they follow the broadcasts posture: authenticated/admin access through the
-- admin app, service-role for the receiver and workers.
ALTER TABLE public.send_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_test_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_test_provision_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_test_runs' AND policyname = 'auth_all_send_test_runs') THEN
    CREATE POLICY "auth_all_send_test_runs" ON public.send_test_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_test_arrivals' AND policyname = 'auth_all_send_test_arrivals') THEN
    CREATE POLICY "auth_all_send_test_arrivals" ON public.send_test_arrivals FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_test_provision_jobs' AND policyname = 'auth_all_send_test_provision_jobs') THEN
    CREATE POLICY "auth_all_send_test_provision_jobs" ON public.send_test_provision_jobs FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.send_test_runs IS
  'One send-test observation window. Arrivals are attributed to it after close by time window (+ optional subject filter). spec-send-testing-module.md.';
COMMENT ON TABLE public.send_test_arrivals IS
  'Messages observed landing in the synthetic test mailboxes via SendGrid Inbound Parse. Headers only, except the small inspectable sample which keeps body_html.';
COMMENT ON TABLE public.send_test_provision_jobs IS
  'Singleton job state for provisioning/deprovisioning the synthetic test population.';
