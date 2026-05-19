-- ============================================================================
-- Module: ai
-- Migration: 008_ai_use_cases_skill_ref
-- Description: Make the system prompt + kickoff message editable per use case,
--              optionally sourced from a git-backed skill file (ai_skills).
--
-- Resolution at runtime (see lib/use-case-prompt.ts):
--   1. If skill_source_id + skill_path are both set AND a matching ai_skills
--      row exists, the skill's body becomes the system prompt.
--   2. Otherwise the inline `system_prompt` column is used.
--   3. `kickoff_message` is the initial user turn sent by autopilot triggers
--      (e.g. daily-briefing "Run research"). Empty = no kickoff message,
--      the system prompt alone drives the model.
--
-- The skill columns are deliberately NOT a FK to ai_skill_sources — that
-- table lives in editor-ai-copilot's migrations, and not every deployment
-- installs editor-ai-copilot. Soft reference keeps the ai module's
-- migrations self-contained.
-- ============================================================================

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS system_prompt   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS kickoff_message text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS skill_source_id uuid,
  ADD COLUMN IF NOT EXISTS skill_path      text;

-- Both halves of the skill ref must be set together, or neither.
ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_skill_ref_both_or_neither;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_skill_ref_both_or_neither
  CHECK (
    (skill_source_id IS NULL AND skill_path IS NULL)
    OR (skill_source_id IS NOT NULL AND skill_path IS NOT NULL)
  );

COMMENT ON COLUMN public.ai_use_cases.system_prompt IS
  'Inline system prompt used when no skill_source_id/skill_path is bound. Editable from /admin/ai/use-cases.';
COMMENT ON COLUMN public.ai_use_cases.kickoff_message IS
  'First user message sent when an operator clicks "Run research" / "Run on all tabs". Empty = no kickoff.';
COMMENT ON COLUMN public.ai_use_cases.skill_source_id IS
  'Soft ref to ai_skill_sources.id. When paired with skill_path, the matching ai_skills.body becomes the system prompt at runtime.';
COMMENT ON COLUMN public.ai_use_cases.skill_path IS
  'Path within the skill source repo, matching ai_skills.path. Soft ref — no FK.';
