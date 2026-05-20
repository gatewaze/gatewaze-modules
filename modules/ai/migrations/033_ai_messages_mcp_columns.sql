-- spec-ai-mcp-extensions.md §3 §6 — chat-turn MCP provenance.
--
-- Mirror of the ai_recipe_runs additions (migration 032) for the
-- chat surface. When chat turns route through `goose session` (per
-- §6 round-6 addendum), MCP wiring applies identically and we need
-- the same provenance columns on the message row.

ALTER TABLE public.ai_messages
  ADD COLUMN IF NOT EXISTS loaded_mcp_server_names        text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS mcp_warnings                   jsonb  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS goose_runtime_overrides_snapshot jsonb;

ALTER TABLE public.ai_messages
  DROP CONSTRAINT IF EXISTS ai_messages_mcp_warnings_array;
ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_mcp_warnings_array
  CHECK (jsonb_typeof(mcp_warnings) = 'array');

COMMENT ON COLUMN public.ai_messages.loaded_mcp_server_names IS
  'MCP servers loaded for this turn. Chat: use_case.allowed_mcp_servers ∩ enabled.';
COMMENT ON COLUMN public.ai_messages.mcp_warnings IS
  'jsonb[] of structured warnings for any MCP server that was allowlisted but couldn`t be loaded.';
