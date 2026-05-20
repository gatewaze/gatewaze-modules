-- Per-run prompt/skill/recipe provenance — operators need to be able to
-- tell which version of a prompt was used for any given research run,
-- not just "what's configured now". Without this you can't tell whether
-- yesterday's chat actually picked up today's prompt edit, or whether a
-- skill update has rolled out across all callers.
--
-- Stored as JSONB to keep the shape forward-compatible — the runtime
-- shape is captured in lib/use-case-prompt.ts (PromptSource) and
-- lib/recipes/run-recipe.ts (RecipeSource).

-- ── ai_messages.prompt_source ─────────────────────────────────────────
-- Snapshot of the prompt-source resolution at run time.
-- {
--   "use_case": "daily-briefing-research",
--   "system_prompt": {
--     "kind": "skill" | "inline" | "fallback" | "empty",
--     "content_hash": "sha256-of-the-string-that-went-to-the-llm",
--     "char_count": 4746,
--     -- present when kind = 'skill':
--     "skill": {
--       "source_id": "uuid",
--       "source_label": "lf-gatewaze-skills",
--       "name": "daily-briefing-research",
--       "dir_path": "skills/daily-briefing-research",
--       "content_hash": "sha256:...",
--       "last_commit_sha": "abc1234"
--     }
--   },
--   "kickoff_message": {
--     "kind": "inline" | "empty",
--     "char_count": 0
--   }
-- }
ALTER TABLE public.ai_messages
  ADD COLUMN IF NOT EXISTS prompt_source jsonb;

COMMENT ON COLUMN public.ai_messages.prompt_source IS
  'Snapshot of the prompt/skill source the worker resolved at run time. NULL for legacy rows. See lib/use-case-prompt.ts:PromptSource for the typed shape. Used by the Run details panel + audit queries to track skill-source rollout.';

-- ── ai_recipe_runs.recipe_source ──────────────────────────────────────
-- Snapshot of the recipe source-ref at run time.
-- {
--   "kind": "source-registered" | "inline",
--   "recipe_id": "uuid (ai_recipes)" | null,
--   "file_path": "recipes/daily-briefing-research/recipe.yaml" | null,
--   "content_hash": "sha256:...",
--   -- present when kind = 'source-registered':
--   "source": {
--     "id": "uuid (ai_recipe_sources)",
--     "label": "lf-gatewaze-skills",
--     "git_url": "https://github.com/gatewaze/lf-gatewaze-skills",
--     "branch": "main",
--     "last_synced_commit": "abc1234"
--   },
--   -- list of sub-recipes that ran:
--   "sub_recipes": [
--     { "file_path": "recipes/.../recipe.yaml", "content_hash": "sha256:...", "last_commit_sha": "..." }
--   ]
-- }
ALTER TABLE public.ai_recipe_runs
  ADD COLUMN IF NOT EXISTS recipe_source jsonb;

COMMENT ON COLUMN public.ai_recipe_runs.recipe_source IS
  'Snapshot of the recipe + sub-recipe source-refs at enqueue time. Distinct from recipe_snapshot (which carries the parsed recipe body); recipe_source carries the git provenance (commit sha, source label) for audit.';

-- Index for "all runs that used skill X" queries — the source path is
-- a discriminator we want to filter by.
CREATE INDEX IF NOT EXISTS ai_messages_prompt_source_skill_idx
  ON public.ai_messages USING gin ((prompt_source -> 'system_prompt' -> 'skill') jsonb_path_ops)
  WHERE prompt_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_recipe_runs_recipe_source_idx
  ON public.ai_recipe_runs USING gin ((recipe_source -> 'source') jsonb_path_ops)
  WHERE recipe_source IS NOT NULL;
