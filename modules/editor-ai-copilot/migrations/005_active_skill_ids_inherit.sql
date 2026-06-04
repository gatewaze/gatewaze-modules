-- ============================================================================
-- Module: editor-ai-copilot
-- Migration: 005_active_skill_ids_inherit
--
-- Give the per-host AI-skill selection three distinct states so a host
-- can INHERIT its use case's default brand skill instead of only ever
-- carrying an explicit list:
--
--   NULL    → inherit the use-case default (newsletter-editor / site-editor
--             skill binding). This is the new default for every host.
--   '{}'    → explicitly NO skills (operator opted out of the default).
--   '{...}' → override with this exact ordered list.
--
-- The columns were created NOT NULL DEFAULT '{}' by 003. Under the old
-- semantics empty simply meant "no skills" (there was no default to
-- inherit). We relax to nullable, drop the default, and migrate the
-- existing '{}' rows to NULL so every host that never made an explicit
-- choice now inherits the use-case default. Hosts that genuinely want
-- zero skills re-assert '{}' via the picker's Override toggle.
--
-- Idempotent + guarded: these columns live on tables owned by other
-- modules (newsletters / sites), added conditionally by 003.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'newsletters_template_collections'
      AND column_name = 'active_skill_ids'
  ) THEN
    ALTER TABLE newsletters_template_collections ALTER COLUMN active_skill_ids DROP DEFAULT;
    ALTER TABLE newsletters_template_collections ALTER COLUMN active_skill_ids DROP NOT NULL;
    UPDATE newsletters_template_collections SET active_skill_ids = NULL WHERE active_skill_ids = '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sites'
      AND column_name = 'active_skill_ids'
  ) THEN
    ALTER TABLE sites ALTER COLUMN active_skill_ids DROP DEFAULT;
    ALTER TABLE sites ALTER COLUMN active_skill_ids DROP NOT NULL;
    UPDATE sites SET active_skill_ids = NULL WHERE active_skill_ids = '{}';
  END IF;
END $$;
