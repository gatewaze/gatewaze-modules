-- spec-ai-job-runner — store a snapshot of the parsed recipe (and its
-- sub-recipes) on the run row at enqueue time.
--
-- Why: the worker runs out-of-process from the API. To rehydrate the
-- recipe definition the worker either has to re-read ai_recipes by
-- recipe_id (works for source-registered recipes) OR have the
-- ParsedRecipe attached to the row itself (required for inline YAML
-- runs that have no source row to look up).
--
-- We store BOTH for source-registered runs too — it shields the worker
-- from race conditions where a `recipe-sync` job mutates the
-- ai_recipes row between the API's INSERT and the worker's pickup.

ALTER TABLE public.ai_recipe_runs
  ADD COLUMN IF NOT EXISTS recipe_snapshot     jsonb,
  ADD COLUMN IF NOT EXISTS sub_recipes_snapshot jsonb;

COMMENT ON COLUMN public.ai_recipe_runs.recipe_snapshot IS
  'Frozen ParsedRecipe at enqueue time. Worker rehydrates from this so a concurrent recipe-sync cant cause the run to see a different version.';
COMMENT ON COLUMN public.ai_recipe_runs.sub_recipes_snapshot IS
  'Frozen map of sub-recipe path -> ParsedRecipe. Same rationale as recipe_snapshot.';
