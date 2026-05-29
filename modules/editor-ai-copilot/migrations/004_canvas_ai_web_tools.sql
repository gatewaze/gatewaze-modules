-- =============================================================================
-- 004_canvas_ai_web_tools — web_search + fetch_url tool support
--
-- Spec: gatewaze-environments/specs/spec-ai-chatbot-web-search.md
--
-- Adds the per-turn audit-log columns for the web_search / fetch_url tools.
--
-- (The legacy canvas_ai_daily_tool_usage table + canvas_ai_bump_tool_usage
-- RPC that originally lived here were removed by 005; budget gating now
-- queries ai_usage_events directly, so they are no longer created at all.)
-- =============================================================================

-- Audit-log extensions.
--    Both jsonb defaults to '[]' so existing rows are unaffected and
--    new rows that don't write the columns still parse as empty arrays.
ALTER TABLE public.canvas_ai_audit_log
  ADD COLUMN IF NOT EXISTS web_searches jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fetched_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.canvas_ai_audit_log.web_searches IS
  'Array of { query, result_count, billed } per spec §2.2.1 — billed counts come from Anthropic usage.server_tool_use.web_search_requests.';
COMMENT ON COLUMN public.canvas_ai_audit_log.fetched_urls IS
  'Array of { url, reason, status, byte_count, mode, fetched_at, source } per spec §4 — one entry per fetch_url tool invocation.';
