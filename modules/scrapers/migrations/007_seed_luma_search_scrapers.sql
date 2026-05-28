-- Migration: 007_seed_luma_search_scrapers.sql
-- Seeds initial LumaSearchScraper instances for keyword-based event discovery

INSERT INTO scrapers (name, scraper_type, object_type, event_type, content_category, base_url, enabled, timeout_minutes, alert_on_failure, config, schedule_enabled, schedule_frequency)
VALUES
  ('Luma Search: AI Agents', 'LumaSearchScraper', 'events', 'mixed', 'community',
   'https://lu.ma/search/ai-agents', true, 15, true,
   '{"keywords": ["AI agents meetup", "AI agents workshop", "agentic AI event"], "maxResultsPerKeyword": 30, "dateRestrict": "m3", "excludePastEvents": true, "titleFilters": ["Agent"]}',
   true, 'daily'),
  ('Luma Search: MCP', 'LumaSearchScraper', 'events', 'mixed', 'community',
   'https://lu.ma/search/mcp', true, 15, true,
   '{"keywords": ["model context protocol", "MCP server workshop", "MCP meetup"], "maxResultsPerKeyword": 30, "dateRestrict": "m3", "excludePastEvents": true, "titleFilters": ["MCP"]}',
   true, 'daily'),
  ('Luma Search: LLM Ops', 'LumaSearchScraper', 'events', 'mixed', 'community',
   'https://lu.ma/search/llmops', true, 15, true,
   '{"keywords": ["LLMOps meetup", "LLM operations", "Demo LLM"], "maxResultsPerKeyword": 30, "dateRestrict": "m3", "excludePastEvents": true}',
   true, 'daily')
-- Partial unique index on base_url (WHERE base_url IS NOT NULL) needs a
-- matching predicate to be inferred as the conflict target.
ON CONFLICT (base_url) WHERE base_url IS NOT NULL DO NOTHING;
