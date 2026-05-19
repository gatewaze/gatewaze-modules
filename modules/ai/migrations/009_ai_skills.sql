-- ============================================================================
-- Module: ai
-- Migration: 009_ai_skills
-- Description: Owns the skill-sources subsystem (moved from
--              editor-ai-copilot's 003 in the Phase 2 refactor).
--
--   - ai_skill_sources           — registered git repos (one row per repo)
--   - ai_skills                  — extracted skill-file cache (one row per .md)
--   - ai_skill_source_webhook_log — recent webhook events for diagnostics
--
-- The ALTER TABLEs that 003 used to do on canvas_ai_audit_log /
-- newsletters_template_collections / sites stay in editor-ai-copilot's
-- own 003 (those columns belong to those modules' tables, not the skill
-- tables).
--
-- pgcrypto's gen_random_bytes() is schema-qualified to `extensions`
-- because on Supabase deployments pgcrypto is installed there, not
-- public — unqualified resolves against public and fails.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. ai_skill_sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_skill_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  label                 text NOT NULL,
  description           text,

  git_url               text NOT NULL,
  branch                text NOT NULL DEFAULT 'main',
  path_prefix           text NOT NULL DEFAULT '',

  auth_token_ciphertext text,
  auth_token_last4      text,

  webhook_secret        text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  webhook_provider      text NOT NULL DEFAULT 'github'
                        CHECK (webhook_provider IN ('github', 'gitlab', 'gitea')),

  last_synced_at        timestamptz,
  last_synced_commit    text,
  sync_status           text NOT NULL DEFAULT 'pending'
                        CHECK (sync_status IN ('pending', 'syncing', 'ok', 'error')),
  sync_error            text,
  sync_lock_token       uuid,
  sync_lock_expires_at  timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),

  CONSTRAINT ai_skill_sources_https_only
    CHECK (git_url LIKE 'https://%'),

  CONSTRAINT ai_skill_sources_path_prefix_safe
    CHECK (
      path_prefix = ''
      OR (
        path_prefix ~ '^[A-Za-z0-9_./-]+$'
        AND path_prefix !~ '(^|/)\.\.(/|$)'
        AND path_prefix !~ '^/'
      )
    ),

  UNIQUE (git_url, branch)
);

CREATE INDEX IF NOT EXISTS ai_skill_sources_status_idx
  ON ai_skill_sources (sync_status);

-- ---------------------------------------------------------------------------
-- 2. ai_skills
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES ai_skill_sources(id) ON DELETE CASCADE,

  path            text NOT NULL,

  name            text NOT NULL,
  description     text,
  tags            text[] NOT NULL DEFAULT '{}',
  applies_to      text[] NOT NULL DEFAULT '{}',

  body            text NOT NULL,
  body_chars      integer NOT NULL,
  content_hash    text NOT NULL,

  -- Reference image (folded in from the Phase-1 editor-ai-copilot 006).
  reference_image_bytes bytea,
  reference_image_mime  text,

  last_commit_sha text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_skills_applies_to_known_values
    CHECK (applies_to <@ ARRAY['newsletter', 'site']::text[]),

  CONSTRAINT ai_skills_reference_image_both_or_neither
    CHECK (
      (reference_image_bytes IS NULL AND reference_image_mime IS NULL)
      OR (reference_image_bytes IS NOT NULL AND reference_image_mime IS NOT NULL)
    ),

  UNIQUE (source_id, path)
);

CREATE INDEX IF NOT EXISTS ai_skills_source_idx
  ON ai_skills (source_id);

CREATE INDEX IF NOT EXISTS ai_skills_applies_to_idx
  ON ai_skills USING gin (applies_to);

-- ---------------------------------------------------------------------------
-- 3. ai_skill_source_webhook_log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_skill_source_webhook_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid REFERENCES ai_skill_sources(id) ON DELETE CASCADE,
  received_at     timestamptz NOT NULL DEFAULT now(),
  remote_addr     inet,
  provider        text NOT NULL,
  event_type      text,
  status          text NOT NULL,
  status_reason   text,
  payload_size    integer,
  signature_valid boolean
);

CREATE INDEX IF NOT EXISTS ai_skill_source_webhook_log_received_idx
  ON ai_skill_source_webhook_log (source_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

ALTER TABLE ai_skill_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_skill_sources_read_admin ON ai_skill_sources;
CREATE POLICY ai_skill_sources_read_admin ON ai_skill_sources
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS ai_skill_sources_write_super_admin ON ai_skill_sources;
CREATE POLICY ai_skill_sources_write_super_admin ON ai_skill_sources
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_skills_read_admin ON ai_skills;
CREATE POLICY ai_skills_read_admin ON ai_skills
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_skill_source_webhook_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_skill_source_webhook_log_read_admin ON ai_skill_source_webhook_log;
CREATE POLICY ai_skill_source_webhook_log_read_admin
  ON ai_skill_source_webhook_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger on ai_skill_sources
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ai_skill_sources_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_skill_sources_updated_at_trigger ON ai_skill_sources;
CREATE TRIGGER ai_skill_sources_updated_at_trigger
  BEFORE UPDATE ON ai_skill_sources
  FOR EACH ROW EXECUTE FUNCTION ai_skill_sources_set_updated_at();
