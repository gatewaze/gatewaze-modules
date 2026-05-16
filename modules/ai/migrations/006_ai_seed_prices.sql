-- ============================================================================
-- Module: ai
-- Migration: 006_ai_seed_prices
-- Description: Seed the price book with current-cutoff prices for the
--              v1 model set. Operators can update these via /admin/ai/prices.
--
--              Prices in USD per million tokens (input/output) or per
--              image. Source: provider docs as of 2026-05. Replace via
--              UPSERT in operator UI when providers update pricing.
-- ============================================================================

-- ── Anthropic ───────────────────────────────────────────────────────────────
INSERT INTO public.ai_model_prices
  (provider, model, input_per_million_usd, output_per_million_usd, cached_per_million_usd,
   supports_chat, supports_tools, supports_web_search, label)
VALUES
  ('anthropic', 'claude-opus-4-5',      15.00,  75.00,  1.50, true, true, true,  'Claude Opus 4.5'),
  ('anthropic', 'claude-sonnet-4-5',     3.00,  15.00,  0.30, true, true, true,  'Claude Sonnet 4.5'),
  ('anthropic', 'claude-haiku-4-5',      0.80,   4.00,  0.08, true, true, false, 'Claude Haiku 4.5')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- ── OpenAI ──────────────────────────────────────────────────────────────────
INSERT INTO public.ai_model_prices
  (provider, model, input_per_million_usd, output_per_million_usd, cached_per_million_usd,
   supports_chat, supports_tools, supports_web_search, supports_image_gen, supports_embeddings, label)
VALUES
  ('openai',    'gpt-5',                 2.50,  10.00,  0.25, true,  true, false, false, false, 'GPT-5'),
  ('openai',    'gpt-5-mini',            0.40,   1.60,  0.04, true,  true, false, false, false, 'GPT-5 mini'),
  ('openai',    'gpt-5-nano',            0.10,   0.40,  0.01, true,  true, false, false, false, 'GPT-5 nano'),
  ('openai',    'o3-mini',               1.10,   4.40,  0.11, true,  true, false, false, false, 'o3-mini'),
  ('openai',    'gpt-image-1',           0.00,   0.00,  NULL, false, false,false, true,  false, 'GPT-Image-1'),
  ('openai',    'text-embedding-3-small',0.02,   0.00,  NULL, false, false,false, false, true,  'text-embedding-3-small'),
  ('openai',    'text-embedding-3-large',0.13,   0.00,  NULL, false, false,false, false, true,  'text-embedding-3-large')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- Image-only pricing for gpt-image-1 (1024x1024 standard quality).
UPDATE public.ai_model_prices
  SET image_per_image_usd = 0.040
  WHERE provider = 'openai' AND model = 'gpt-image-1';

-- ── Google Gemini ───────────────────────────────────────────────────────────
INSERT INTO public.ai_model_prices
  (provider, model, input_per_million_usd, output_per_million_usd, cached_per_million_usd,
   supports_chat, supports_tools, supports_web_search, supports_image_gen, label)
VALUES
  ('gemini',    'gemini-3-pro',          1.25,   5.00,  0.13, true,  true, true,  false, 'Gemini 3 Pro'),
  ('gemini',    'gemini-2.5-pro',        1.25,   5.00,  0.13, true,  true, true,  false, 'Gemini 2.5 Pro'),
  ('gemini',    'gemini-2.5-flash',      0.10,   0.40,  0.01, true,  true, true,  false, 'Gemini 2.5 Flash'),
  ('gemini',    'gemini-2.5-flash-image',0.00,   0.00,  NULL, false, false,false, true,  'Gemini 2.5 Flash Image ("Nano Banana")')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

UPDATE public.ai_model_prices
  SET image_per_image_usd = 0.030
  WHERE provider = 'gemini' AND model = 'gemini-2.5-flash-image';

-- ── Scrapling (web-fetch tool, billed via gatewaze-fetch) ───────────────────
-- Modelled here so the cost dashboard can attribute fetch-tool spend
-- alongside LLM spend without a special-case path.
INSERT INTO public.ai_model_prices
  (provider, model, input_per_million_usd, output_per_million_usd,
   supports_chat, supports_tools, label)
VALUES
  ('scrapling', 'fetch_url:fast',        0.00,   0.00,  false, true, 'Scrapling fetch_url (fast)'),
  ('scrapling', 'fetch_url:stealth',     0.00,   0.00,  false, true, 'Scrapling fetch_url (stealth)'),
  ('scrapling', 'fetch_url:browser',     0.00,   0.00,  false, true, 'Scrapling fetch_url (browser)')
ON CONFLICT (provider, model, effective_from) DO NOTHING;
-- Note: scrapling costs are computed from request_count / bytes /
-- browser_seconds in code (see lib/cost.ts), not from token columns.
