-- ============================================================================
-- Module: newsletters
-- Migration: 053_send_engine_batches
-- Description: Central Sending Service foundation for the newsletter domain
-- (spec-central-sending-service.md; Tier 2 migration 050 + the brand/channel
-- columns the shared quota/watchdog key on). Batch tracking for the worker-side
-- sendBatch drip + the watchdog index. ADDITIVE + inert until the engine is
-- wired and SEND_ENGINE_USE_WORKER is flipped — current sending is unchanged.
-- ============================================================================

-- Per-batch tracking (one row per SendGrid sendBatch call) for surgical retry +
-- crash recovery ('posting' inserted before the call; promoted to 'accepted' on
-- 202, 'failed'/'rejected'/'partial' otherwise).
CREATE TABLE IF NOT EXISTS public.newsletter_send_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id           uuid NOT NULL REFERENCES public.newsletter_sends(id) ON DELETE CASCADE,
  worker_replica    text,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  provider_batch_id text,
  recipient_count   integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('posting','posted','accepted','rejected','partial','failed')),
  http_status       integer,
  error_summary     text,
  completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_newsletter_send_batches_send ON public.newsletter_send_batches (send_id, posted_at DESC);

ALTER TABLE public.newsletter_send_recipients
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.newsletter_send_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_newsletter_send_recipients_batch
  ON public.newsletter_send_recipients (batch_id) WHERE batch_id IS NOT NULL;

-- Watchdog index (Tier 2): recent sent rows per send for the bounce/spam gate.
CREATE INDEX IF NOT EXISTS idx_email_send_log_send_sent
  ON public.email_send_log (newsletter_send_id, sent_at) WHERE sent_at IS NOT NULL;

-- brand + channel on the send: the shared sender_daily_quota + reputation
-- watchdog key on (brand, channel). brand resolved at fanout from the
-- collection/host; channel defaults to email.
ALTER TABLE public.newsletter_sends ADD COLUMN IF NOT EXISTS brand text;
ALTER TABLE public.newsletter_sends ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
