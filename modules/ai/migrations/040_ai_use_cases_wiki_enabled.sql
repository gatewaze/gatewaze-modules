-- ============================================================================
-- Module: ai
-- Migration: 040_ai_use_cases_wiki_enabled
-- Description: Per-use-case toggle for the AI memory wiki runtime (the
--              gatewaze-wiki MCP tools + pre-turn RAG injection). Defaults
--              TRUE so every agentic use case (recipe + chat Goose runs, and
--              the in-process providers) gets durable, searchable wiki memory.
--              Operators opt a use case out by setting wiki_enabled = false.
--
--              Embedding / image use cases (e.g. portal-ai-search,
--              content-pipeline-embed, daily-briefing-cover) never enter the
--              agent loop, so the flag is moot for them — but it is harmless
--              to leave on. spec-ai-memory-wiki.md §5.1/§5.2.
-- ============================================================================

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS wiki_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.ai_use_cases.wiki_enabled IS
  'When true (default), agentic runs for this use case load the gatewaze-wiki '
  'MCP (wiki_search/read/upsert/list) and inject relevant wiki pages into the '
  'prompt (RAG). Set false to opt the use case out of wiki memory.';
