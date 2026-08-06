-- ============================================================================
-- Module: event-speakers
-- Migration: 014_seed_promo_posts_use_case
-- Description: Seed + bind the speaker-promo-posts AI use-case (the four
--              LinkedIn-ready post variants in a speaker's promo kit) to its
--              recipe in the gatewaze/lf-agents source. Skipped gracefully when
--              the ai module is not installed — the promo-kit worker then ships
--              cards + tracking link without text. Idempotent.
-- ============================================================================

DO $$
DECLARE
  v_source_id uuid;
BEGIN
  IF to_regclass('public.ai_use_cases') IS NULL
     OR to_regclass('public.ai_agent_sources') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping speaker-promo-posts use-case seed';
    RETURN;
  END IF;

  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'speaker-promo-posts',
    'Speaker promo posts',
    'Writes the four LinkedIn-ready promotional post variants for one confirmed speaker''s promo kit (professional / energetic / technical / community), embedding the speaker''s personal tracking link.',
    'anthropic', 'claude-sonnet-5',
    ARRAY['claude-sonnet-5'],
    -- Four full posts of structured output comfortably exceed goose's 4096
    -- default; see the final_output/max_tokens note in the ai module.
    ARRAY[]::text[], 12000, 5000000
  ) ON CONFLICT (id) DO NOTHING;

  SELECT id INTO v_source_id
    FROM public.ai_agent_sources
   WHERE git_url = 'https://github.com/gatewaze/lf-agents.git'
     AND branch = 'main';

  IF v_source_id IS NULL THEN
    INSERT INTO public.ai_agent_sources (label, description, git_url, branch, path_prefix)
    VALUES (
      'LF Agents',
      'Shared goose recipes + skills (gatewaze/lf-agents)',
      'https://github.com/gatewaze/lf-agents.git',
      'main',
      ''
    )
    RETURNING id INTO v_source_id;
  END IF;

  UPDATE public.ai_use_cases SET
      recipe_source_id = v_source_id,
      recipe_file_path = 'recipes/speaker-promo-posts/recipe.yaml',
      updated_at = now()
    WHERE id = 'speaker-promo-posts';

  RAISE NOTICE 'seeded speaker-promo-posts use-case (source %)', v_source_id;
END
$$;
