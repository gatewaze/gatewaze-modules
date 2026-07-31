-- ============================================================================
-- Module: vehicle-video
-- Migration: 002_seed_use_cases
-- Description: Seed the four AI use-cases the pipeline runs (style, script,
--              clip-prompt, voiceover). Recipe bindings are (re)asserted in 003
--              so they survive a reseed. Skipped gracefully if the ai module is
--              not installed. Idempotent.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.ai_use_cases') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping vehicle-video use-case seed';
    RETURN;
  END IF;

  -- style & audience (psychographic + market-aware) — Claude Sonnet
  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'vehicle-video-style',
    'Vehicle Video — style & audience',
    'Infers a vehicle''s likely buyer psychographic- and market-first and derives a style profile (character/template + pacing/camera/tone/voice).',
    'anthropic', 'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-haiku-4-5'],
    ARRAY[]::text[], 4000, 5000000
  ) ON CONFLICT (id) DO NOTHING;

  -- curated shot list (multimodal vision) — Claude Sonnet
  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'vehicle-video-script',
    'Vehicle Video — curated shot list',
    'Reads the photo gallery + details and curates an ordered set of shots (best image per beat, style-shaped narration + camera).',
    'anthropic', 'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5'],
    ARRAY[]::text[], 8000, 8000000
  ) ON CONFLICT (id) DO NOTHING;

  -- per-shot Veo prompt shaping (cheap) — Claude Haiku
  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'vehicle-video-clip-prompt',
    'Vehicle Video — Veo clip prompt',
    'Turns one approved shot into a single Veo generation prompt + negative prompt.',
    'anthropic', 'claude-haiku-4-5',
    ARRAY['claude-haiku-4-5','claude-sonnet-4-5'],
    ARRAY[]::text[], 2000, 3000000
  ) ON CONFLICT (id) DO NOTHING;

  -- final voiceover script — Claude Sonnet
  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'vehicle-video-voiceover',
    'Vehicle Video — voiceover script',
    'Stitches the approved shots'' narration into one TTS-ready voiceover script within the video duration.',
    'anthropic', 'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-haiku-4-5'],
    ARRAY[]::text[], 4000, 5000000
  ) ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'seeded vehicle-video AI use-cases';
END
$$;
