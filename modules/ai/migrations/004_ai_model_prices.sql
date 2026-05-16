-- ============================================================================
-- Module: ai
-- Migration: 004_ai_model_prices
-- Description: Price book per (provider, model, effective_from). Operator-
--              editable; seeded by migration 006 with current cutoff prices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_model_prices (
  provider                 text NOT NULL CHECK (provider IN ('openai','anthropic','gemini','scrapling')),
  model                    text NOT NULL,
  effective_from           date NOT NULL DEFAULT CURRENT_DATE,

  -- Per-million-input/output token USD pricing (numeric for precision).
  input_per_million_usd    numeric(10,4) NOT NULL DEFAULT 0,
  output_per_million_usd   numeric(10,4) NOT NULL DEFAULT 0,
  cached_per_million_usd   numeric(10,4),                -- null = no cache discount
  -- Per-image USD for image-gen models (gemini-2.5-flash-image, gpt-image-1).
  image_per_image_usd      numeric(10,6),

  -- Capability flags so the model picker can filter the list.
  supports_chat            boolean NOT NULL DEFAULT true,
  supports_tools           boolean NOT NULL DEFAULT false,
  supports_web_search      boolean NOT NULL DEFAULT false,
  supports_image_gen       boolean NOT NULL DEFAULT false,
  supports_embeddings      boolean NOT NULL DEFAULT false,

  label                    text NOT NULL DEFAULT '',     -- 'Claude Sonnet 4.5', 'GPT-5 nano', ...

  PRIMARY KEY (provider, model, effective_from)
);

COMMENT ON TABLE public.ai_model_prices IS
  'Price book for AI provider models. Includes effective_from so historical cost calculations stay accurate. Operator-editable at /admin/ai/prices.';

CREATE INDEX IF NOT EXISTS ai_model_prices_current_idx
  ON public.ai_model_prices (provider, model, effective_from DESC);

ALTER TABLE public.ai_model_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_model_prices_select_authenticated" ON public.ai_model_prices;
CREATE POLICY "ai_model_prices_select_authenticated"
  ON public.ai_model_prices FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ai_model_prices_admin_write" ON public.ai_model_prices;
CREATE POLICY "ai_model_prices_admin_write"
  ON public.ai_model_prices FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Helper: look up the price effective at a given timestamp.
CREATE OR REPLACE FUNCTION public.ai_price_at(
  p_provider text,
  p_model text,
  p_at timestamptz DEFAULT now()
) RETURNS public.ai_model_prices
LANGUAGE sql STABLE
AS $$
  SELECT *
    FROM public.ai_model_prices
    WHERE provider = p_provider
      AND model = p_model
      AND effective_from <= p_at::date
    ORDER BY effective_from DESC
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.ai_price_at IS
  'Returns the price row in effect for (provider, model) at the given timestamp. Used by the cost-ledger writer.';
