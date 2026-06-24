-- ============================================================================
-- Module: bulk-emailing
-- Migration: 017_event_batch_recipients
-- Description: Tier-2 drip foundation for event communications. Today the
-- email-batch-send edge fn resolves recipients on the fly and sends inline
-- (Tier 1). To put event comms on the shared worker drip engine + SendingPanel
-- (like newsletters/broadcasts), we add a per-recipient QUEUE that the existing
-- resolution code enqueues into (capturing each recipient's full substitution
-- context as jsonb — reusing the battle-tested per-audience resolution rather
-- than reimplementing it as SQL fan-out), then the worker drips from it.
--
--   email_batch_jobs            = the send instances (already exist; parent=event)
--   email_batch_job_recipients  = NEW per-recipient drip queue (this migration)
--
-- Also widens email_batch_jobs.status to the shared SendingPanel vocabulary so
-- the shared engine + panel can drive event sends. ADDITIVE: Tier-1 values kept.
-- ============================================================================

-- 1. Per-recipient drip queue (mirrors broadcast_send_recipients + a per-recipient
--    `context` jsonb = the TemplateContext used for {{scope.field}} substitution).
CREATE TABLE IF NOT EXISTS public.email_batch_job_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES public.email_batch_jobs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  person_id   text,                                            -- recipient_customer_id / profile id (loose: audiences vary)
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,              -- per-recipient substitution context (customer/event/speaker/calendar)
  send_at     timestamptz NOT NULL DEFAULT now(),             -- UTC instant to dispatch
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','sending','sent','failed','skipped')),
  strategy    text NOT NULL DEFAULT 'global'
              CHECK (strategy IN ('global','tz_local','personalised')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  timezone    text,                                            -- resolved IANA zone at enqueue
  send_log_id uuid,                                            -- → email_send_log row
  batch_id    uuid,                                            -- → provider batch (sendBatch)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  CONSTRAINT uq_ebjr_job_email UNIQUE (job_id, email)
);

CREATE INDEX IF NOT EXISTS idx_ebjr_due ON public.email_batch_job_recipients (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ebjr_job ON public.email_batch_job_recipients (job_id);

ALTER TABLE public.email_batch_job_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_all_email_batch_job_recipients ON public.email_batch_job_recipients;
CREATE POLICY auth_all_email_batch_job_recipients ON public.email_batch_job_recipients FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_batch_job_recipients TO anon, authenticated, service_role;

-- 2. Widen email_batch_jobs.status to the shared SendingPanel vocabulary.
--    Additive: existing Tier-1 values (pending/processing/completed/...) kept.
ALTER TABLE public.email_batch_jobs DROP CONSTRAINT IF EXISTS email_batch_jobs_status_check;
ALTER TABLE public.email_batch_jobs ADD CONSTRAINT email_batch_jobs_status_check
  CHECK (status IN ('pending','processing','completed','failed','cancelled','scheduled','sending','sent','cancelling','paused'));

-- 3. Claim due recipients atomically (FOR UPDATE SKIP LOCKED) so concurrent
--    worker ticks/replicas don't double-send. Gates on the job being active.
CREATE OR REPLACE FUNCTION public.claim_due_email_batch_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.email_batch_job_recipients
LANGUAGE sql
AS $$
  UPDATE public.email_batch_job_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT er.id
    FROM public.email_batch_job_recipients er
    JOIN public.email_batch_jobs j ON j.id = er.job_id
    WHERE er.status = 'pending'
      AND er.send_at <= now()
      AND j.status IN ('sending', 'processing')
    ORDER BY er.send_at
    LIMIT p_limit
    FOR UPDATE OF er SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

COMMENT ON FUNCTION public.claim_due_email_batch_recipients(integer) IS
  'Atomically claim due event-comms recipients for the Tier-2 worker drip (cf. claim_due_broadcast_recipients).';

-- 4. Per-timezone breakdown for the shared SendingPanel (param named p_send_id
--    to match the adapter's tzBreakdownRpc call; the "send" here is the job).
CREATE OR REPLACE FUNCTION public.email_batch_job_timezone_breakdown(p_send_id uuid)
RETURNS TABLE (timezone text, recipients bigint, sent bigint, failed bigint, pending bigint, skipped bigint, send_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(r.timezone, 'UTC') AS timezone,
    count(*) AS recipients,
    count(*) FILTER (WHERE r.status = 'sent') AS sent,
    count(*) FILTER (WHERE r.status = 'failed') AS failed,
    count(*) FILTER (WHERE r.status IN ('pending', 'sending')) AS pending,
    count(*) FILTER (WHERE r.status = 'skipped') AS skipped,
    min(r.send_at) AS send_at
  FROM public.email_batch_job_recipients r
  WHERE r.job_id = p_send_id
  GROUP BY COALESCE(r.timezone, 'UTC')
  ORDER BY min(r.send_at);
$$;
