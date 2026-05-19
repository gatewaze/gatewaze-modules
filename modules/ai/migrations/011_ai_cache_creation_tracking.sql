-- ============================================================================
-- Module: ai
-- Migration: 011_ai_cache_creation_tracking
-- Description: Tracks Anthropic's cache-creation input tokens separately
--              from regular input + cache-read tokens. Anthropic bills
--              cache-creation at ~1.25× the regular input rate (a one-
--              time premium for writing the cache, recouped on subsequent
--              cache reads at 0.1×). Without this column the ledger has
--              no place to capture these tokens, producing a small but
--              real under-count we observed when reconciling Gatewaze
--              vs Anthropic's billing dashboard.
--
--              Existing rows default to 0 — no migration of historical
--              cost values (those snapshotted ai_price_at at write time
--              and are immutable per the cost-ledger contract).
-- ============================================================================

-- 1. Track per-row cache-creation token count.
ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS cache_creation_tokens integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ai_usage_events.cache_creation_tokens IS
  'Tokens used to CREATE a prompt-caching entry. Anthropic bills these at 1.25× the regular input rate. Separate from input_tokens (non-cached) and cached_tokens (cache reads, 0.1× rate).';

-- 2. Track per-model cache-creation price. NULL = "no premium documented;
--    fall back to input_per_million_usd at compute time."
ALTER TABLE public.ai_model_prices
  ADD COLUMN IF NOT EXISTS cache_creation_per_million_usd numeric(10,4);

COMMENT ON COLUMN public.ai_model_prices.cache_creation_per_million_usd IS
  'Price per million cache-creation input tokens, in USD. Anthropic models charge ~1.25× the regular input rate. NULL means the runner should fall back to input_per_million_usd (no premium).';

-- 3. Seed Anthropic models at 1.25× their input rate. Source: Anthropic
--    prompt-caching pricing as of 2026-05.
UPDATE public.ai_model_prices
  SET cache_creation_per_million_usd = 18.7500
  WHERE provider = 'anthropic' AND model = 'claude-opus-4-5';

UPDATE public.ai_model_prices
  SET cache_creation_per_million_usd = 3.7500
  WHERE provider = 'anthropic' AND model = 'claude-sonnet-4-5';

UPDATE public.ai_model_prices
  SET cache_creation_per_million_usd = 1.0000
  WHERE provider = 'anthropic' AND model = 'claude-haiku-4-5';
