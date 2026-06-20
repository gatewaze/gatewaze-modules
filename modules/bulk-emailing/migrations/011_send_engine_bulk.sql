-- ============================================================================
-- Module: bulk-emailing
-- Migration: 011_send_engine_bulk
-- Description: Central Sending Service foundation for the BULK domain
-- (spec-central-sending-service.md §Phase 3). Keeps email_batch_jobs as the
-- "send" row (per the resolved open question — minimises event-comms churn) and
-- adds the recipients queue + batch tracking + fanout/claim so bulk blasts can
-- ride the SAME worker drip engine as newsletters + broadcasts.
--
-- ADDITIVE + INERT: nothing here changes the existing synchronous
-- email-batch-send loop. The engine path only runs under SEND_ENGINE_USE_WORKER
-- once a job is fanned out into bulk_send_recipients. The legacy loop remains
-- the default until the per-source fanout is migrated and the flag is flipped.
-- ============================================================================

-- email_send_log gains bulk attribution (already has newsletter_/broadcast_).
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS bulk_send_id uuid;

-- email_batch_jobs is the bulk "send" row → it needs the shared quota keys so
-- bulk blasts share the per-(brand,channel) SendGrid daily cap with the others.
ALTER TABLE public.email_batch_jobs ADD COLUMN IF NOT EXISTS brand text;
ALTER TABLE public.email_batch_jobs ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Per-recipient timing queue for bulk blasts (the proven newsletter/broadcast
-- shape). template_variables carries the per-recipient render context the
-- binding substitutes into subject_template/content_template — the bulk content
-- model is template + per-recipient variables, not a single rendered_html.
CREATE TABLE IF NOT EXISTS public.bulk_send_recipients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id            uuid NOT NULL REFERENCES public.email_batch_jobs(id) ON DELETE CASCADE,
  person_id          uuid,
  email              text NOT NULL,
  template_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  send_at            timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending',
  strategy           text NOT NULL DEFAULT 'global',
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  timezone           text,
  batch_id           uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bulk_send_recipients_due
  ON public.bulk_send_recipients (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bulk_send_recipients_send
  ON public.bulk_send_recipients (send_id);

-- Per-batch tracking (mirror of newsletter_/broadcast_send_batches).
CREATE TABLE IF NOT EXISTS public.bulk_send_batches (
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
CREATE INDEX IF NOT EXISTS idx_bulk_send_batches_send ON public.bulk_send_batches (send_id, posted_at DESC);

ALTER TABLE public.bulk_send_recipients
  DROP CONSTRAINT IF EXISTS bulk_send_recipients_batch_id_fkey;
ALTER TABLE public.bulk_send_recipients
  ADD CONSTRAINT bulk_send_recipients_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES public.bulk_send_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_send_recipients_batch
  ON public.bulk_send_recipients (batch_id) WHERE batch_id IS NOT NULL;

-- Watchdog index (Tier 2): recent sent rows per send for the reputation gate.
CREATE INDEX IF NOT EXISTS idx_email_send_log_bulk_sent
  ON public.email_send_log (bulk_send_id, sent_at) WHERE sent_at IS NOT NULL;

-- Drip claim: same contract as claim_due_newsletter/broadcast_recipients —
-- FOR UPDATE SKIP LOCKED, gated on the parent job being actively sending.
-- email_batch_jobs uses status='processing' for the active state.
CREATE OR REPLACE FUNCTION public.claim_due_bulk_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.bulk_send_recipients
LANGUAGE sql
AS $function$
  UPDATE public.bulk_send_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT bsr.id
    FROM public.bulk_send_recipients bsr
    JOIN public.email_batch_jobs s ON s.id = bsr.send_id
    WHERE bsr.status = 'pending'
      AND bsr.send_at <= now()
      AND s.status IN ('processing', 'sending')
    ORDER BY bsr.send_at
    LIMIT p_limit
    FOR UPDATE OF bsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$function$;

-- Adhoc fanout: materialise an explicit person list into the queue with the
-- standard merge-field variables. The richer event/registration sources keep
-- their TS context-building for now (the legacy loop); this covers the simplest
-- source and lets the engine path be exercised. p_people = jsonb array of
-- { email, person_id?, variables? }.
CREATE OR REPLACE FUNCTION public.fanout_bulk_send_recipients(p_job_id uuid, p_people jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.bulk_send_recipients (send_id, person_id, email, template_variables, send_at, status)
  SELECT
    p_job_id,
    NULLIF(elem->>'person_id','')::uuid,
    elem->>'email',
    COALESCE(elem->'variables', '{}'::jsonb),
    now(),
    'pending'
  FROM jsonb_array_elements(p_people) elem
  WHERE COALESCE(elem->>'email','') <> ''
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;
