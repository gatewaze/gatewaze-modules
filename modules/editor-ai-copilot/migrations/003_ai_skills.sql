-- ============================================================================
-- Module: editor-ai-copilot
-- Migration: 003_ai_skills (post Phase-2 refactor)
--
-- The three skill tables (ai_skill_sources, ai_skills,
-- ai_skill_source_webhook_log) MOVED to the ai module
-- (gatewaze-modules/modules/ai/migrations/009_ai_skills.sql). All this
-- migration owns now is the cross-module column additions on tables
-- that editor-ai-copilot is the canonical owner of:
--
--   - canvas_ai_audit_log.active_skill_*  (editor's own audit table)
--
-- The active_skill_ids columns on `newsletters_template_collections`
-- and `sites` were also added by the original 003. Those have been
-- left alone — they're idempotent ADD COLUMN IF NOT EXISTS guards,
-- they harm nothing if editor-ai-copilot is the one applying them.
-- A future pass should move them into newsletters / sites migrations
-- respectively so each module owns its own schema.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- canvas_ai_audit_log — skill auditing columns
-- ---------------------------------------------------------------------------

ALTER TABLE canvas_ai_audit_log
  ADD COLUMN IF NOT EXISTS active_skill_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS active_skill_hashes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS active_skill_truncations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Per-host pointer columns (legacy — ideally these move to their owning
-- modules' migrations; idempotent today so harmless to keep here).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'newsletters_template_collections'
  ) THEN
    EXECUTE 'ALTER TABLE newsletters_template_collections
             ADD COLUMN IF NOT EXISTS active_skill_ids uuid[] NOT NULL DEFAULT ''{}''';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'sites'
  ) THEN
    EXECUTE 'ALTER TABLE sites
             ADD COLUMN IF NOT EXISTS active_skill_ids uuid[] NOT NULL DEFAULT ''{}''';
  END IF;
END $$;
