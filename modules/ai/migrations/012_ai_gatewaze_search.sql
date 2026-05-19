-- 012_ai_gatewaze_search.sql
--
-- Extend allowed_web_tools to accept 'gatewaze_search' — the new
-- model-agnostic web discovery tool the AI module exposes to every
-- provider. Backed by Serper.dev (when SERPER_API_KEY is set) or a
-- DuckDuckGo HTML scrape via scrapling-fetcher (free fallback). See
-- lib/gatewaze-search.ts for the resolver implementation.
--
-- Replaces the prior CHECK constraint that only permitted
-- {'web_search','fetch_url'}.

ALTER TABLE ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_allowed_web_tools_check;

ALTER TABLE ai_use_cases
  ADD CONSTRAINT ai_use_cases_allowed_web_tools_check
  CHECK (allowed_web_tools <@ ARRAY['web_search','fetch_url','gatewaze_search']::text[]);

-- Enable gatewaze_search on daily-briefing-research alongside the
-- existing tools. Operators can flip this per-use-case via the AI >
-- Use Cases admin page; this seed just ensures the new tool is on by
-- default for the use case that originally motivated the build.
UPDATE ai_use_cases
SET allowed_web_tools = (
  SELECT ARRAY(SELECT DISTINCT unnest(
    allowed_web_tools || ARRAY['gatewaze_search']::text[]
  ))
)
WHERE id = 'daily-briefing-research'
  AND NOT ('gatewaze_search' = ANY(allowed_web_tools));
