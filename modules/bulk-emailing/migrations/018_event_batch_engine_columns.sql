-- ============================================================================
-- Module: bulk-emailing
-- Migration: 018_event_batch_engine_columns
-- Description: Make email_batch_jobs drivable by the shared worker drip engine +
-- SendingPanel. The engine's finalize writes sent_count/failed_count to the
-- sends table, and the panel reads them; Tier-1 used success_count/fail_count
-- (kept for back-compat). Also adds the provider-batch tracking table the engine
-- needs (mirrors broadcast_send_batches).
-- ============================================================================

-- 1. Counts the shared engine writes + the SendingPanel reads (Tier-1's
--    success_count/fail_count are kept; Tier-2 uses these).
ALTER TABLE public.email_batch_jobs ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.email_batch_jobs ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;

-- 2. Provider-batch tracking for the worker engine (sendBatch crash-recovery
--    anchor) — mirrors broadcast_send_batches / newsletter_send_batches.
CREATE TABLE IF NOT EXISTS public.email_batch_job_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id           uuid NOT NULL REFERENCES public.email_batch_jobs(id) ON DELETE CASCADE,
  worker_replica    text,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  provider_batch_id text,
  recipient_count   integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('posting','posted','accepted','rejected','partial','failed')),
  http_status       integer,
  error_summary     text,
  completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ebjb_send ON public.email_batch_job_batches (send_id);
CREATE INDEX IF NOT EXISTS idx_ebjb_posting ON public.email_batch_job_batches (status, posted_at) WHERE status = 'posting';

ALTER TABLE public.email_batch_job_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_all_email_batch_job_batches ON public.email_batch_job_batches;
CREATE POLICY auth_all_email_batch_job_batches ON public.email_batch_job_batches FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_batch_job_batches TO anon, authenticated, service_role;
