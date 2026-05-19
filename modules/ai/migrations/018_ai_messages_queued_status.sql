-- spec-ai-job-runner §6.1 — extend ai_messages.status for worker-dispatch
-- + add cross-reference to BullMQ job.
--
-- Existing values (from 002_ai_threads_messages.sql):
--   'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
-- New values:
--   'queued'      — assistant message row inserted; BullMQ job enqueued.
--   'cancelling'  — cancel requested; worker hasn't honoured yet.

ALTER TABLE public.ai_messages
  DROP CONSTRAINT IF EXISTS ai_messages_status_check;

ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_status_check
    CHECK (status IN ('pending','queued','running','cancelling','complete','failed','cancelled'));

ALTER TABLE public.ai_messages
  ADD COLUMN IF NOT EXISTS bull_job_id text,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

COMMENT ON COLUMN public.ai_messages.bull_job_id IS
  'BullMQ job ID for the worker that produced (or is producing) this assistant message.';
COMMENT ON COLUMN public.ai_messages.cancel_requested_at IS
  'Set by API when the user clicks cancel; worker reads at step boundary as backstop for the pub/sub cancel.';
