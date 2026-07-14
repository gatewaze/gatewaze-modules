-- Structured Resources — cover-image use case.
--
-- Binds a 'resources-cover-image' AI use case to the lf-agents
-- recipes/resources-cover-image/recipe.yaml. The module's
-- lib/cover-image.ts resolves this use case's recipe-bound skill body as
-- the image prompt TEMPLATE and calls Gemini directly (the recipe is not
-- executed by Goose for image generation — same pattern as the
-- daily-briefing and lunch-and-learn covers). Idempotent; safe to re-run.
--
-- Skipped cleanly when the ai module isn't installed, so this stays inert
-- on deployments that don't run the AI cover-image feature.

DO $$
DECLARE
  v_source_id uuid;
BEGIN
  IF to_regclass('public.ai_agent_sources') IS NULL
     OR to_regclass('public.ai_use_cases') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping resources-cover-image use-case seed';
    RETURN;
  END IF;

  -- Reuse (or register) the LF Agents git source that carries the recipe + skill.
  SELECT id INTO v_source_id
    FROM public.ai_agent_sources
   WHERE git_url = 'https://github.com/gatewaze/lf-agents.git'
     AND branch = 'main';

  IF v_source_id IS NULL THEN
    INSERT INTO public.ai_agent_sources (label, description, git_url, branch, path_prefix)
    VALUES (
      'LF Agents',
      'Linux Foundation agent recipes + skills (ambassador review, daily briefing, lunch & learn, resources, etc.)',
      'https://github.com/gatewaze/lf-agents.git',
      'main',
      ''
    )
    RETURNING id INTO v_source_id;
  END IF;

  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd,
     recipe_source_id, recipe_file_path)
  VALUES (
    'resources-cover-image',
    'Structured Resources cover image',
    'Renders the AAIF-branded cover image for a Structured Resource (collection or item) via the lf-agents resources-cover-image recipe + skill. Single 16:9 editorial illustration (Gemini nano-banana).',
    'gemini',
    'gemini-2.5-flash-image',
    ARRAY['gemini-2.5-flash-image'],
    ARRAY[]::text[],
    4096,
    NULL,
    v_source_id,
    'recipes/resources-cover-image/recipe.yaml'
  )
  ON CONFLICT (id) DO UPDATE
    SET recipe_source_id = EXCLUDED.recipe_source_id,
        recipe_file_path = EXCLUDED.recipe_file_path,
        description      = EXCLUDED.description,
        default_provider = EXCLUDED.default_provider,
        default_model    = EXCLUDED.default_model,
        allowed_models   = EXCLUDED.allowed_models,
        updated_at       = now();

  RAISE NOTICE 'seeded resources-cover-image use-case (source %)', v_source_id;
END
$$;
