-- ============================================================================
-- Module: ai
-- Migration: 013_ai_skills_agentskills_io
-- Description: Replace the existing Gatewaze-proprietary `ai_skills` shape
--              with an agentskills.io-conformant schema. Per spec-ai-
--              workflows-and-skill-interop.md §6.1, the existing schema
--              has zero production rows and is replaced rather than
--              migrated. A precondition guard refuses the drop if any
--              row exists, so we cannot silently lose data.
--
-- New schema invariants (per spec §3.2 + §4.1):
--   - `name` is the canonical identifier and must equal basename(dir_path).
--   - `description` is required (≤1024). Gatewaze is strict here even
--     though Claude Code marks it "recommended"; the spec requires it.
--   - `metadata` is a flat string→string map (validated by parser).
--   - `resources` lists sibling-file relative paths for forward-compat;
--     INERT at runtime in v1 (admin-display only, per §3.2).
--   - `parse_status` records whether the skill loaded clean, was refused
--     (Tier-3 feature), or hit a parse error (malformed YAML, etc.).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai_skills LIMIT 1) THEN
    RAISE EXCEPTION 'migration 013: ai_skills has rows; cannot drop. Investigate before re-running.';
  END IF;
END$$;

DROP TABLE IF EXISTS ai_skills CASCADE;

CREATE TABLE ai_skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES ai_skill_sources(id) ON DELETE CASCADE,

  -- name = directory basename per agentskills.io invariant; dir_path
  -- is the full path within the repo for indexing + audit.
  name            text NOT NULL,
  dir_path        text NOT NULL,

  description     text NOT NULL,                           -- required ≤1024
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,      -- flat string→string
  resources       jsonb NOT NULL DEFAULT '[]'::jsonb,      -- sibling-file paths (inert v1)

  body            text NOT NULL,
  body_chars      integer NOT NULL,
  content_hash    text NOT NULL,

  parse_status         text NOT NULL CHECK (parse_status IN ('ok','refused','parse_error')),
  unsupported_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,

  last_commit_sha text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- name regex matches the agentskills.io grammar (lowercase, hyphen-
  -- separated, no leading/trailing/consecutive hyphens).
  CONSTRAINT ai_skills_name_grammar
    CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),

  -- dir_path basename must equal name. SQL doesn't have basename(); we
  -- approximate with a regex check that the last `/`-separated segment
  -- equals name. Parser performs the authoritative check.
  CONSTRAINT ai_skills_name_matches_dir
    CHECK (split_part(dir_path, '/', greatest(1, array_length(string_to_array(dir_path, '/'), 1))) = name),

  CONSTRAINT ai_skills_description_length CHECK (char_length(description) <= 1024),

  UNIQUE (source_id, dir_path)
);

CREATE INDEX ai_skills_source_idx ON ai_skills (source_id);
CREATE INDEX ai_skills_parse_status_idx ON ai_skills (parse_status) WHERE parse_status <> 'ok';
CREATE INDEX ai_skills_metadata_gin ON ai_skills USING gin (metadata jsonb_path_ops);
CREATE INDEX ai_skills_name_idx ON ai_skills (name);

-- ---------------------------------------------------------------------------
-- RLS — admin-only read/write, mirrors migration 009 policies.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_skills_read_admin ON ai_skills;
CREATE POLICY ai_skills_read_admin ON ai_skills
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS ai_skills_write_admin ON ai_skills;
CREATE POLICY ai_skills_write_admin ON ai_skills
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );
