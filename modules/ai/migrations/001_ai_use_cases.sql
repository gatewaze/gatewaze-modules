-- ============================================================================
-- Module: ai
-- Migration: 001_ai_use_cases
-- Description: Registry of AI use-cases. Each entry maps a string id
--              (e.g. 'editor-ai-copilot', 'daily-briefing-research') to
--              defaults: provider, model, allowed_models list, allowed
--              web tools, max_output_tokens, and a daily soft cost cap.
--
-- Seeded by module manifest declarations at install time, then operator-
-- editable via /admin/ai/use-cases.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_use_cases (
  id                          text PRIMARY KEY,           -- 'editor-ai-copilot'
  label                       text NOT NULL,              -- 'Canvas editor copilot'
  description                 text NOT NULL DEFAULT '',
  default_provider            text NOT NULL DEFAULT 'auto'
                              CHECK (default_provider IN ('auto', 'openai', 'anthropic', 'gemini')),
  default_model               text NOT NULL,              -- e.g. 'claude-sonnet-4-5'
  -- Ordered allow-list. `default_provider='auto'` walks this in order.
  allowed_models              text[] NOT NULL DEFAULT '{}',
  -- Per-use-case web tool allowlist. Empty = no tools.
  allowed_web_tools           text[] NOT NULL DEFAULT '{}'
                              CHECK (allowed_web_tools <@ ARRAY['web_search','fetch_url']::text[]),
  max_output_tokens           integer NOT NULL DEFAULT 8000,
  daily_cost_cap_micro_usd    bigint,                     -- null = no cap (warn only)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_use_cases IS
  'Registry of AI use-cases consumed by the ai module. Maps id → defaults + allowed models + allowed tools + cost cap. Seeded by module manifests, operator-editable.';

DROP TRIGGER IF EXISTS ai_use_cases_updated_at ON public.ai_use_cases;
CREATE TRIGGER ai_use_cases_updated_at
  BEFORE UPDATE ON public.ai_use_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ai_use_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_use_cases_select_authenticated" ON public.ai_use_cases;
CREATE POLICY "ai_use_cases_select_authenticated"
  ON public.ai_use_cases FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ai_use_cases_admin_write" ON public.ai_use_cases;
CREATE POLICY "ai_use_cases_admin_write"
  ON public.ai_use_cases FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
