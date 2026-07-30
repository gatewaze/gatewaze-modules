-- ============================================================================
-- bulk-emailing 023: reconcile diverged email_batch_job_recipients to send_id
--
-- Migration 017 was rewritten (a consolidation) AFTER some environments had
-- already applied an earlier version that created email_batch_job_recipients
-- with a `job_id` column. Because 017 is recorded in module_migrations, the
-- module runner never re-applies the corrected version, so those environments
-- are stuck with the old `job_id` shape while the current email-batch-send edge
-- fn and the worker's eventCommsBinding (+ claim_due_email_batch_recipients)
-- expect `send_id`. Result: event/speaker comms enqueue fails / nothing drips
-- and sends sit on "pending / 0 sent".
--
-- This migration brings the diverged objects to the canonical 017 shape. The
-- recipients queue is a transient work table (it only holds in-flight drip rows)
-- and is empty on the affected env, so we drop + recreate rather than rename —
-- guaranteeing an exact match to canonical, including the claim + tz-breakdown
-- RPCs that reference the column. email_batch_job_batches (018) already carries
-- send_id and email_batch_jobs already has sent_count/failed_count, so those are
-- left untouched. Idempotent on already-canonical envs: the DROPs are IF EXISTS
-- and the recreate matches 017 exactly.
-- ============================================================================

DROP FUNCTION IF EXISTS public.claim_due_email_batch_recipients(integer);
DROP FUNCTION IF EXISTS public.email_batch_job_timezone_breakdown(uuid);
DROP TABLE IF EXISTS public.email_batch_job_recipients CASCADE;

-- Per-recipient drip queue (canonical 017 §1) — keyed by send_id.
CREATE TABLE public.email_batch_job_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id      uuid NOT NULL REFERENCES public.email_batch_jobs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  person_id   text,
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,
  send_at     timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','sending','sent','failed','skipped')),
  strategy    text NOT NULL DEFAULT 'global'
              CHECK (strategy IN ('global','tz_local','personalised')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  timezone    text,
  send_log_id uuid,
  batch_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  CONSTRAINT uq_ebjr_job_email UNIQUE (send_id, email)
);

CREATE INDEX IF NOT EXISTS idx_ebjr_due ON public.email_batch_job_recipients (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ebjr_job ON public.email_batch_job_recipients (send_id);

ALTER TABLE public.email_batch_job_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_all_email_batch_job_recipients ON public.email_batch_job_recipients;
CREATE POLICY auth_all_email_batch_job_recipients ON public.email_batch_job_recipients FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_batch_job_recipients TO anon, authenticated, service_role;

-- Widen email_batch_jobs.status to the shared SendingPanel vocabulary (canonical 017 §2, idempotent).
ALTER TABLE public.email_batch_jobs DROP CONSTRAINT IF EXISTS email_batch_jobs_status_check;
ALTER TABLE public.email_batch_jobs ADD CONSTRAINT email_batch_jobs_status_check
  CHECK (status IN ('pending','processing','completed','failed','cancelled','scheduled','sending','sent','cancelling','paused'));

-- Claim due recipients atomically (canonical 017 §3).
CREATE OR REPLACE FUNCTION public.claim_due_email_batch_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.email_batch_job_recipients
LANGUAGE sql
AS $$
  UPDATE public.email_batch_job_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT er.id
    FROM public.email_batch_job_recipients er
    JOIN public.email_batch_jobs j ON j.id = er.send_id
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

-- Per-timezone breakdown for the SendingPanel (canonical 017 §4).
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
  WHERE r.send_id = p_send_id
  GROUP BY COALESCE(r.timezone, 'UTC')
  ORDER BY min(r.send_at);
$$;
