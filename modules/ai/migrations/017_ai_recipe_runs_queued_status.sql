-- spec-ai-job-runner §6.1 — extend ai_recipe_runs.status to include the
-- worker-dispatch lifecycle states.
--
-- Existing values: 'running' (default), 'complete', 'failed', 'cancelled',
-- 'budget_blocked'.
-- New values:
--   'queued'      — row exists, BullMQ job enqueued, worker hasn't picked up yet.
--   'cancelling'  — operator/user requested cancel; worker hasn't honoured yet.

-- Drop the existing CHECK and re-add with the expanded set. Postgres has no
-- ALTER … ADD VALUE on a CHECK constraint, so this is the cleanest path.
ALTER TABLE public.ai_recipe_runs
  DROP CONSTRAINT IF EXISTS ai_recipe_runs_status_check;

ALTER TABLE public.ai_recipe_runs
  ADD CONSTRAINT ai_recipe_runs_status_check
    CHECK (status IN ('queued','running','cancelling','complete','failed','cancelled','budget_blocked'));

-- Default flips from 'running' to 'queued' — the API enqueues before the
-- worker picks up.
ALTER TABLE public.ai_recipe_runs
  ALTER COLUMN status SET DEFAULT 'queued';

-- New columns for cross-reference + cancel tracking.
ALTER TABLE public.ai_recipe_runs
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS bull_job_id        text,
  ADD COLUMN IF NOT EXISTS retry_of_run_id    uuid REFERENCES public.ai_recipe_runs(id) ON DELETE SET NULL;

-- Index supports the Jobs tab's "recent active runs" listing.
CREATE INDEX IF NOT EXISTS ai_recipe_runs_status_started_idx
  ON public.ai_recipe_runs (status, started_at DESC);

COMMENT ON COLUMN public.ai_recipe_runs.cancel_requested_at IS
  'Set by API when DELETE /admin/recipe-runs/:id arrives; worker reads at step boundary as backstop for the pub/sub cancel.';
COMMENT ON COLUMN public.ai_recipe_runs.bull_job_id IS
  'BullMQ job ID for cross-reference from the row to the queue.';
COMMENT ON COLUMN public.ai_recipe_runs.retry_of_run_id IS
  'Set on operator-initiated retries — points to the original failed run.';
