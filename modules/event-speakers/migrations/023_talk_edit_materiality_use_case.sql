-- ============================================================================
-- Module: event-speakers
-- Migration: 023_talk_edit_materiality_use_case
-- Description: Registers the talk-edit materiality judge as an ai_use_cases
--              row so runChat can resolve credentials, model and cost cap
--              (it throws "use_case '<id>' not registered" otherwise).
--
--              haiku: the task is a short, well-bounded comparison of two
--              texts with forced structured output — not a reasoning-heavy
--              job — and it runs on every speaker edit, so the cheap model is
--              the right default. Operators can raise it per install.
--
--              No web tools: the judge must reason ONLY about the two
--              versions it is given.
--
--              Skipped when the ai module is absent (event-speakers does not
--              depend on it) — the sweep then records 'failed' and the talk
--              simply stays pending, which is the pre-AI behaviour.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.ai_use_cases') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping talk-edit-materiality use case';
    RETURN;
  END IF;

  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES
    (
      'talk-edit-materiality',
      'Talk edit materiality',
      'Decides whether a speaker''s edit to their talk title/synopsis changed the substance of the talk (needs re-review) or was a minor wording, typo or formatting fix (keep the existing approved/confirmed status). Forced structured output, no web tools.',
      'auto',
      'claude-haiku-4-5',
      ARRAY['claude-haiku-4-5','claude-sonnet-4-5','claude-sonnet-5'],
      ARRAY[]::text[],
      600,
      NULL
    )
  ON CONFLICT (id) DO NOTHING;
END
$$;
