-- ============================================================================
-- Module: ai
-- Migration: 041_ai_use_cases_wiki_mode
-- Description: Per-use-case wiki participation MODE, superseding the boolean
--              wiki_enabled (040). Distinguishes HOW wiki participates in a run:
--
--                'tools'   - attach the gatewaze-wiki MCP so the model reads/
--                            writes wiki live. Conversational use cases only;
--                            structured-output recipes are stripped regardless
--                            (see run-recipe-goose §4.1 minimal-tool-surface
--                            guardrail).
--                'context' - deterministic two-phase memory: pre-turn recall
--                            injected as {{ wiki_context }}, post-success
--                            persist. The mode for structured-output recipes
--                            (e.g. lunch-and-learn-writeup) that want memory
--                            without the agentic tools that break Goose
--                            structured output finalization.
--                'off'     - no wiki participation.
--
--              wiki_enabled is retained as a read-through: wiki_enabled=false
--              => effective 'off'. Backfill maps false -> 'off', else 'tools'
--              (preserving today's default-on behaviour for conversational use
--              cases). spec-ai-wiki-runtime-integration.md §4.2/§6.
-- ============================================================================

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS wiki_mode text NOT NULL DEFAULT 'tools'
    CHECK (wiki_mode IN ('tools', 'context', 'off'));

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS wiki_persist_enabled boolean NOT NULL DEFAULT true;

-- Backfill mode from the legacy boolean: opted-out use cases -> 'off',
-- everything else keeps the default-on 'tools' behaviour. Idempotent: only
-- rows still at the column default that were explicitly disabled move to 'off'.
UPDATE public.ai_use_cases
   SET wiki_mode = 'off'
 WHERE wiki_enabled = false
   AND wiki_mode = 'tools';

COMMENT ON COLUMN public.ai_use_cases.wiki_mode IS
  'How the wiki participates in a run: tools (attach gatewaze-wiki MCP; '
  'conversational only), context (deterministic recall->write->persist for '
  'structured-output recipes), off (none). Read WITH wiki_enabled: '
  'wiki_enabled=false forces off. spec-ai-wiki-runtime-integration.md.';

COMMENT ON COLUMN public.ai_use_cases.wiki_persist_enabled IS
  'When wiki_mode=context, whether a successful run persists its result back '
  'to the wiki (default true). Set false for recall-only use cases.';
