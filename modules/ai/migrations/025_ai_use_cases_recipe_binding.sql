-- Add recipe binding to ai_use_cases.
--
-- 008 added skill_source_id + skill_path so an operator could bind a
-- git-tracked SKILL (markdown body becomes the system prompt). Now
-- that ai_agent_sources unifies skills + recipes, a use case can also
-- bind to a RECIPE — when set, "Run" on that use case executes the
-- recipe DAG instead of firing a free-form chat turn.
--
-- A use case has at most ONE binding: skill XOR recipe. Both null = use
-- the inline system_prompt column. We enforce mutual exclusion via a
-- CHECK constraint so the runtime resolver doesn't have to handle a
-- "both set" case.

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS recipe_source_id uuid
    REFERENCES public.ai_agent_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipe_file_path text;

-- recipe_source_id + recipe_file_path must be set together, or neither.
ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_recipe_ref_both_or_neither;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_recipe_ref_both_or_neither
  CHECK (
    (recipe_source_id IS NULL AND recipe_file_path IS NULL)
    OR (recipe_source_id IS NOT NULL AND recipe_file_path IS NOT NULL)
  );

-- skill binding and recipe binding are mutually exclusive.
ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_skill_or_recipe_not_both;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_skill_or_recipe_not_both
  CHECK (NOT (skill_source_id IS NOT NULL AND recipe_source_id IS NOT NULL));

COMMENT ON COLUMN public.ai_use_cases.recipe_source_id IS
  'FK to ai_agent_sources. When paired with recipe_file_path, "Run" on this use case enqueues an ai:run-recipe job against the bound recipe. Mutually exclusive with skill_source_id.';
COMMENT ON COLUMN public.ai_use_cases.recipe_file_path IS
  'Repo-relative path of the recipe.yaml within the bound source.';
