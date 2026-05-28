-- =============================================================================
-- 004_canvas_ai_web_tools — web_search + fetch_url tool support
--
-- Spec: gatewaze-environments/specs/spec-ai-chatbot-web-search.md
--
-- Adds:
--   1. canvas_ai_audit_log.web_searches  (jsonb)   — per-turn search log
--   2. canvas_ai_audit_log.fetched_urls  (jsonb)   — per-turn fetch log
--   3. canvas_ai_daily_tool_usage         (table)   — daily quota + cost
--
-- Platform is single-tenant per deployment (per spec-ai-skills.md §0.0)
-- so the rollup is keyed by tool only — no tenant_id column.
-- =============================================================================

-- 1. Audit-log extensions.
--    Both jsonb defaults to '[]' so existing rows are unaffected and
--    new rows that don't write the columns still parse as empty arrays.
ALTER TABLE public.canvas_ai_audit_log
  ADD COLUMN IF NOT EXISTS web_searches jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fetched_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.canvas_ai_audit_log.web_searches IS
  'Array of { query, result_count, billed } per spec §2.2.1 — billed counts come from Anthropic usage.server_tool_use.web_search_requests.';
COMMENT ON COLUMN public.canvas_ai_audit_log.fetched_urls IS
  'Array of { url, reason, status, byte_count, mode, fetched_at, source } per spec §4 — one entry per fetch_url tool invocation.';

-- 2. Daily quota + cost rollup. One row per (day_utc, tool_name).
--    Incremented at request time after each successful tool invocation.
--    Used to enforce daily_quota and daily_cost_budget_usd (spec §6.6 / §6.7).
CREATE TABLE IF NOT EXISTS public.canvas_ai_daily_tool_usage (
  day_utc       date NOT NULL,
  tool_name     text NOT NULL CHECK (tool_name IN ('web_search', 'fetch_url')),
  call_count    int  NOT NULL DEFAULT 0,
  -- Cost in micro-USD (1e-6 dollars) so we can store sub-cent precision
  -- without rounding floats. 1c = 10_000; $1 = 1_000_000.
  cost_micro_usd bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day_utc, tool_name)
);

COMMENT ON TABLE public.canvas_ai_daily_tool_usage IS
  'Daily quota + cost rollup for the AI chatbot tool-use surface. Keyed by (day_utc, tool_name). Service-role writes; admins read for the dashboard.';

CREATE INDEX IF NOT EXISTS idx_canvas_ai_daily_tool_usage_day
  ON public.canvas_ai_daily_tool_usage (day_utc DESC);

-- 3. RLS — single-tenant deployment, but we still gate reads to admins.
ALTER TABLE public.canvas_ai_daily_tool_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canvas_ai_daily_tool_usage_select ON public.canvas_ai_daily_tool_usage;
CREATE POLICY canvas_ai_daily_tool_usage_select
  ON public.canvas_ai_daily_tool_usage
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_profiles ap
      WHERE ap.user_id = auth.uid()
        AND ap.role IN ('super_admin', 'admin')
    )
  );

-- Writes are service-role only (bypasses RLS); no INSERT/UPDATE policy needed.

-- 4. Atomic upsert-and-increment RPC. Avoids a select-then-update
--    race when two parallel requests bump the same (day, tool) row.
--    Returns the post-increment count + cost so the caller can decide
--    whether to strip the tool from the next array.
CREATE OR REPLACE FUNCTION public.canvas_ai_bump_tool_usage(
  p_tool_name     text,
  p_call_delta    int,
  p_cost_micro_usd bigint
) RETURNS TABLE (call_count int, cost_micro_usd bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_tool_name NOT IN ('web_search', 'fetch_url') THEN
    RAISE EXCEPTION 'invalid tool_name: %', p_tool_name;
  END IF;
  IF p_call_delta < 0 OR p_cost_micro_usd < 0 THEN
    RAISE EXCEPTION 'deltas must be non-negative';
  END IF;

  INSERT INTO public.canvas_ai_daily_tool_usage (day_utc, tool_name, call_count, cost_micro_usd)
  VALUES (v_day, p_tool_name, p_call_delta, p_cost_micro_usd)
  ON CONFLICT (day_utc, tool_name) DO UPDATE
    SET call_count     = canvas_ai_daily_tool_usage.call_count     + p_call_delta,
        cost_micro_usd = canvas_ai_daily_tool_usage.cost_micro_usd + p_cost_micro_usd
  RETURNING canvas_ai_daily_tool_usage.call_count, canvas_ai_daily_tool_usage.cost_micro_usd
  INTO call_count, cost_micro_usd;

  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.canvas_ai_bump_tool_usage(text, int, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canvas_ai_bump_tool_usage(text, int, bigint) TO service_role;

COMMENT ON FUNCTION public.canvas_ai_bump_tool_usage IS
  'Atomically increment daily_tool_usage and return the post-update counters. Service-role only.';
