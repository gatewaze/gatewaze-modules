-- ============================================================================
-- Module: ai
-- Migration: 039_ai_editor_use_cases_split
-- Description: Split the single `editor-ai-copilot` use case into one per
--              host kind — `newsletter-editor` and `site-editor` — so each
--              can carry its own model defaults, cost cap, and (the point
--              of the split) its own DEFAULT brand skill bound via the
--              existing skill_source_id / skill_path columns.
--
-- The editor copilot resolves its use case from the host kind at runtime
-- (editor-ai-copilot/lib/use-case.ts). The old `editor-ai-copilot` row is
-- removed.
--
-- FK handling: ai_threads.use_case, ai_usage_events.use_case and
-- ai_recipes.use_case reference ai_use_cases(id) with ON DELETE RESTRICT
-- (or NO ACTION), so dependents are repointed before the delete:
--   - ai_threads carry host_kind, so they repoint precisely.
--   - ai_usage_events carry no host kind, so historical editor spend
--     folds into newsletter-editor (the editor skill feature was a no-op
--     before this change — see the skills-repo schema fix — so there is
--     little-to-no real history to misattribute).
-- Tables whose use_case FK is ON DELETE CASCADE (ai_credentials,
-- ai_use_case_mcp_allowlist, ai_memory) are cleaned up by the delete.
-- ============================================================================

-- 1. Seed the two replacement use cases, copying the editor-ai-copilot
--    defaults. Idempotent: ON CONFLICT keeps any operator edits already
--    made to a re-run.
INSERT INTO public.ai_use_cases
  (id, label, description, default_provider, default_model, allowed_models, allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
VALUES
  (
    'newsletter-editor',
    'Newsletter editor copilot',
    'AI sidebar in the Puck-based newsletter editor. Generates or revises newsletter editions from prompts; tool-uses fetch_url for source-document grounding. Default brand skill bound below applies to every host that has not overridden it.',
    'auto',
    'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-opus-4-5','gpt-5','gpt-5-mini','gemini-3-pro'],
    ARRAY['web_search','fetch_url']::text[],
    8000,
    NULL
  ),
  (
    'site-editor',
    'Site editor copilot',
    'AI sidebar in the Puck-based site editor. Generates or revises site pages from prompts; tool-uses fetch_url for source-document grounding. Default brand skill bound below applies to every site that has not overridden it.',
    'auto',
    'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-opus-4-5','gpt-5','gpt-5-mini','gemini-3-pro'],
    ARRAY['web_search','fetch_url']::text[],
    8000,
    NULL
  )
ON CONFLICT (id) DO NOTHING;

-- 2. Repoint dependents off the old id (only when it still exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_use_cases WHERE id = 'editor-ai-copilot') THEN

    -- Threads carry host_kind → repoint precisely.
    UPDATE public.ai_threads
       SET use_case = CASE WHEN host_kind = 'newsletter' THEN 'newsletter-editor' ELSE 'site-editor' END
     WHERE use_case = 'editor-ai-copilot';

    -- Usage events have no host kind → fold into newsletter-editor.
    UPDATE public.ai_usage_events
       SET use_case = 'newsletter-editor'
     WHERE use_case = 'editor-ai-copilot';

    -- Recipes (none expected for the editor) → fold into newsletter-editor.
    -- Guard on column existence: ai_recipes.use_case was added by a
    -- later schema-evolution step on some projects but never landed on
    -- AAIF, where this UPDATE would otherwise hard-fail the migration.
    -- The comment above is the canonical statement: no editor recipes
    -- are expected, so a no-op is correct when the column is absent.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'ai_recipes'
         AND column_name = 'use_case'
    ) THEN
      UPDATE public.ai_recipes
         SET use_case = 'newsletter-editor'
       WHERE use_case = 'editor-ai-copilot';
    END IF;

    -- 3. Remove the old row. CASCADE handles ai_credentials /
    --    ai_use_case_mcp_allowlist / ai_memory rows tagged to it.
    DELETE FROM public.ai_use_cases WHERE id = 'editor-ai-copilot';
  END IF;
END $$;
