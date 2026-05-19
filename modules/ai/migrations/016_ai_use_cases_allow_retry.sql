-- spec-ai-job-runner §6.1 — operator-configurable retry policy for crashed runs.
--
-- Default is false because most tool calls are non-idempotent. Operators flip
-- this to true on a per-use-case basis (e.g. content-pipeline summarisation,
-- where read-only tool calls + idempotent provider responses make a retry safe).

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS allow_retry boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ai_use_cases.allow_retry IS
  'When true, BullMQ retries crashed runs once with step-checkpoint skip (spec-ai-job-runner §4.4). Default false because most tool calls are non-idempotent.';
