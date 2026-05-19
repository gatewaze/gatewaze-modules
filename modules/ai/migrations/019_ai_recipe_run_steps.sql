-- spec-ai-job-runner §6.1 — per-step checkpoint table.
--
-- Today, ai_recipe_runs.steps is a denormalised JSONB array — convenient for
-- reading the final run summary but inefficient for the worker's "what's
-- already complete?" check on retry. This table is the canonical step-level
-- record; the JSONB array on the parent row is kept as a denormalised view
-- (updated by the worker as each step completes) for backwards compatibility
-- with the existing admin UI.

CREATE TABLE IF NOT EXISTS public.ai_recipe_run_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_run_id  uuid NOT NULL REFERENCES public.ai_recipe_runs(id) ON DELETE CASCADE,

  -- 0-based DFS order; unique per run.
  step_index     int NOT NULL,
  -- Stable machine-readable id from the recipe definition (e.g. "research",
  -- "cover-image"). Used to correlate retries to the same logical step across
  -- DAG changes. Distinct from step_index (sequence) and any human-readable
  -- label rendered in the UI.
  step_id        text NOT NULL,

  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','complete','failed','cancelled','skipped')),

  structured     jsonb,
  narrative      text,
  cost_micro_usd bigint NOT NULL DEFAULT 0,
  duration_ms    int,
  started_at     timestamptz,
  completed_at   timestamptz,

  UNIQUE (recipe_run_id, step_index)
);

CREATE INDEX IF NOT EXISTS ai_recipe_run_steps_run_idx
  ON public.ai_recipe_run_steps (recipe_run_id, step_index);

-- Worker uses this when retrying — list steps already complete, skip them.
CREATE INDEX IF NOT EXISTS ai_recipe_run_steps_complete_idx
  ON public.ai_recipe_run_steps (recipe_run_id) WHERE status = 'complete';

COMMENT ON TABLE public.ai_recipe_run_steps IS
  'Per-step checkpoint for recipe runs (spec-ai-job-runner §6.1). Worker UPSERTs each row as the step transitions. Survives retries — the worker reads this table to skip already-complete steps when allow_retry=true.';

ALTER TABLE public.ai_recipe_run_steps ENABLE ROW LEVEL SECURITY;
