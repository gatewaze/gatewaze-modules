-- ============================================================================
-- Module: vehicle-video
-- Migration: 003_seed_recipe_bindings
-- Description: Register the danthebaker/agents recipe/skill source and bind the
--              four vehicle-video use-cases to their recipes, declaratively, so
--              they survive a DB reset / reseed. Mirrors daily-briefing's 009.
--              Idempotent; order-independent vs 002. The migration-025 CHECK
--              enforces recipe XOR skill, so we clear any stale skill binding.
-- ============================================================================

DO $$
DECLARE
  v_source_id uuid;
BEGIN
  IF to_regclass('public.ai_agent_sources') IS NULL
     OR to_regclass('public.ai_use_cases') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping vehicle-video recipe-binding seed';
    RETURN;
  END IF;

  -- The danthebaker/agents source holds the vehicle-video recipes + skills.
  -- UNIQUE (git_url, branch). Create it if not already present.
  SELECT id INTO v_source_id
    FROM public.ai_agent_sources
   WHERE git_url = 'https://github.com/danthebaker/agents.git'
     AND branch = 'main';

  IF v_source_id IS NULL THEN
    INSERT INTO public.ai_agent_sources (label, description, git_url, branch, path_prefix)
    VALUES (
      'danthebaker Agents',
      'Reusable agent recipes + skills (vehicle-video, etc.)',
      'https://github.com/danthebaker/agents.git',
      'main',
      ''
    )
    RETURNING id INTO v_source_id;
  END IF;

  UPDATE public.ai_use_cases SET
      recipe_source_id = v_source_id,
      recipe_file_path = 'recipes/vehicle-video-style/recipe.yaml',
      skill_source_id  = NULL, skill_path = NULL, updated_at = now()
    WHERE id = 'vehicle-video-style';

  UPDATE public.ai_use_cases SET
      recipe_source_id = v_source_id,
      recipe_file_path = 'recipes/vehicle-video-script/recipe.yaml',
      skill_source_id  = NULL, skill_path = NULL, updated_at = now()
    WHERE id = 'vehicle-video-script';

  UPDATE public.ai_use_cases SET
      recipe_source_id = v_source_id,
      recipe_file_path = 'recipes/vehicle-video-clip-prompt/recipe.yaml',
      skill_source_id  = NULL, skill_path = NULL, updated_at = now()
    WHERE id = 'vehicle-video-clip-prompt';

  UPDATE public.ai_use_cases SET
      recipe_source_id = v_source_id,
      recipe_file_path = 'recipes/vehicle-video-voiceover/recipe.yaml',
      skill_source_id  = NULL, skill_path = NULL, updated_at = now()
    WHERE id = 'vehicle-video-voiceover';

  RAISE NOTICE 'seeded vehicle-video recipe bindings (source %)', v_source_id;
END
$$;
