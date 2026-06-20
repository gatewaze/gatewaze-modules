-- ============================================================================
-- Module: broadcasts
-- Migration: 004_send_engine_batches
-- Description: Central Sending Service foundation for the broadcast domain
-- (spec-central-sending-service.md). broadcast_sends already carries brand +
-- channel and broadcast_send_recipients already has batch_id (001), so this
-- only adds the per-batch tracking table + the reputation-watchdog index.
-- ADDITIVE + inert until SEND_ENGINE_USE_WORKER routes the broadcast drip
-- through the worker engine — current sending is unchanged.
-- ============================================================================

-- Per-batch tracking (one row per SendGrid sendBatch call) for surgical retry +
-- crash recovery ('posting' inserted before the call; promoted to 'accepted' on
-- 202, 'failed'/'rejected'/'partial' otherwise). Mirrors newsletter_send_batches.
CREATE TABLE IF NOT EXISTS public.broadcast_send_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id           uuid NOT NULL REFERENCES public.broadcast_sends(id) ON DELETE CASCADE,
  worker_replica    text,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  provider_batch_id text,
  recipient_count   integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('posting','posted','accepted','rejected','partial','failed')),
  http_status       integer,
  error_summary     text,
  completed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_broadcast_send_batches_send ON public.broadcast_send_batches (send_id, posted_at DESC);

-- broadcast_send_recipients.batch_id exists (001); ensure the FK + lookup index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcast_send_recipients_batch_id_fkey'
      AND conrelid = 'public.broadcast_send_recipients'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.broadcast_send_recipients
      ADD CONSTRAINT broadcast_send_recipients_batch_id_fkey
      FOREIGN KEY (batch_id) REFERENCES public.broadcast_send_batches(id) ON DELETE SET NULL';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_broadcast_send_recipients_batch
  ON public.broadcast_send_recipients (batch_id) WHERE batch_id IS NOT NULL;

-- Watchdog index (Tier 2): recent sent rows per send for the bounce/spam gate.
CREATE INDEX IF NOT EXISTS idx_email_send_log_broadcast_sent
  ON public.email_send_log (broadcast_send_id, sent_at) WHERE sent_at IS NOT NULL;
