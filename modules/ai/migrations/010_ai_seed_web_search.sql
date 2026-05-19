-- ============================================================================
-- Module: ai
-- Migration: 010_ai_seed_web_search
-- Description: Adds an `anthropic/web_search` catalog entry so the cost
--              ledger has a model row to attribute web_search tool calls
--              against. Pricing isn't computed from this row (the runner
--              uses costMicroUsdOverride = $10 / 1000 requests directly,
--              since web_search is per-request not per-token), but the
--              entry exists so the AI usage dashboard's by-provider /
--              by-model breakdowns include web_search alongside the LLM
--              spend, and so the AI models admin page surfaces it for
--              operator visibility.
-- ============================================================================

INSERT INTO public.ai_model_prices
  (provider, model, input_per_million_usd, output_per_million_usd,
   supports_chat, supports_tools, supports_web_search, label)
VALUES
  ('anthropic', 'web_search', 0, 0, false, false, true,
   'Anthropic web_search (billed $10 per 1000 requests)')
ON CONFLICT (provider, model, effective_from) DO NOTHING;
