-- ============================================================================
-- Module: broadcasts
-- Migration: 003_segments_copilot_use_case
-- Description: Register the AI segment copilot as an `ai_use_cases` row so the
-- AI module's runChat can resolve credentials, model, and cost cap for it
-- (runChat throws "use_case '<id>' not registered" without this). Mirrors the
-- editor-ai-copilot use cases (ai migration 039). No web tools — the copilot is
-- a pure structured-output translator.
--
-- Requires the `ai` module (broadcasts depends on it) so ai_use_cases exists.
-- Idempotent: ON CONFLICT keeps any operator edits on a re-run.
-- ============================================================================

INSERT INTO public.ai_use_cases
  (id, label, description, default_provider, default_model, allowed_models, allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
VALUES
  (
    'segments-copilot',
    'Segment copilot',
    'Turns a natural-language audience description into a validated Gatewaze segment definition (forced tool use). Used by the broadcasts Audience step. No web tools.',
    'auto',
    'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-opus-4-5','gpt-5','gpt-5-mini','gemini-3-pro'],
    ARRAY[]::text[],
    2000,
    NULL
  )
ON CONFLICT (id) DO NOTHING;
