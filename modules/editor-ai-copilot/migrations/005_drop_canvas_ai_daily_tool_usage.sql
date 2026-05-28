-- ============================================================================
-- Module: editor-ai-copilot
-- Migration: 005_drop_canvas_ai_daily_tool_usage
-- Description: Drop the legacy per-tool daily counter table + its RPC.
--              After spec-ai-module follow-up #1 the editor's web-tool
--              budget gates query ai_usage_events directly (filtered to
--              use_case='editor-ai-copilot' + the (provider, model) tuple
--              for each tool). The legacy table has no live data to
--              preserve since the new ledger runs in parallel from
--              install — operators who care about the historical
--              counter values queried 004's table directly anyway.
--
-- Safe to apply because:
--   1. lib/web-tools/quota.ts no longer references the table or RPC.
--   2. dispatch.ts uses the new path via the refactored quota module.
--   3. No other module reads canvas_ai_daily_tool_usage (grep-verified).
-- ============================================================================

DROP FUNCTION IF EXISTS public.canvas_ai_bump_tool_usage(text, integer, bigint);
DROP TABLE IF EXISTS public.canvas_ai_daily_tool_usage;
