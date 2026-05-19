-- ============================================================================
-- Module: ai
-- Migration: 015_ai_recipes_version_prompt
-- Description: Adds `version` and `prompt` columns to ai_recipes so the
--              canonical Goose recipe shape (per the aaif/agents repo
--              convention — version: "1.0.0" + prompt: |) survives the
--              parse-then-rehydrate round trip used by the per-id run
--              endpoint.
--
-- Both columns are nullable — recipes that don't declare them keep the
-- previous behaviour (placeholder user-turn, untagged schema version).
-- ============================================================================

ALTER TABLE public.ai_recipes
  ADD COLUMN IF NOT EXISTS version text,
  ADD COLUMN IF NOT EXISTS prompt text;

COMMENT ON COLUMN public.ai_recipes.version IS
  'Optional schema-version tag from the recipe YAML (e.g. "1.0.0"). Informational; the parser does not branch on it.';
COMMENT ON COLUMN public.ai_recipes.prompt IS
  'Optional initial user-turn message (Goose prompt: field). When set, the executor uses this as the first user message instead of a placeholder. Subject to {{ param }} substitution.';
