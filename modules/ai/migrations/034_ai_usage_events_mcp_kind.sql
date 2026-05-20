-- spec-ai-mcp-extensions.md §Data Models §ai_usage_events extension.
--
-- Widen ai_usage_events.kind CHECK constraint to include 'mcp_tool'
-- so MCP tool calls captured from Goose's stream-json events can be
-- recorded with the same cost-ledger attribution shape as
-- kind='tool' web_search/fetch_url calls.

ALTER TABLE public.ai_usage_events
  DROP CONSTRAINT IF EXISTS ai_usage_events_kind_check;
ALTER TABLE public.ai_usage_events
  ADD CONSTRAINT ai_usage_events_kind_check
  CHECK (kind IN ('llm', 'tool', 'embedding', 'image', 'mcp_tool'));

COMMENT ON CONSTRAINT ai_usage_events_kind_check ON public.ai_usage_events IS
  'Adds mcp_tool for tool calls captured from Goose stream-json. provider=<mcp-server-name>, model=<tool-name>. Cost computed via ai_model_prices when (provider, model) is registered there, else 0.';
