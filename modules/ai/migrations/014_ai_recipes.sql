-- ============================================================================
-- Module: ai
-- Migration: 014_ai_recipes
-- Description: Recipe (Goose-compatible workflow) execution surface per
--              spec-ai-workflows-and-skill-interop.md §6.2.
--
-- Tables created:
--   ai_recipe_sources     — registered git repos (mirrors ai_skill_sources)
--   ai_recipes            — parsed Goose recipes, keyed by (source, file_path)
--   ai_recipe_runs        — one row per runRecipe() invocation (audit root)
--   ai_recipe_memory      — per-run KV store for the `builtin: memory` tool
--
-- Modifications:
--   ai_usage_events       — add recipe_run_id, recipe_step_index for backref
--   ai_use_cases          — add recipe_source_id, recipe_file_path for pinning
--
-- Cost ledger contract: every step's runChat() call writes one row to
-- ai_usage_events tagged with recipe_run_id + recipe_step_index, so a
-- recipe's full cost can be reconstructed by joining on recipe_run_id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ai_recipe_sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_recipe_sources (
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

  CONSTRAINT ai_recipe_sources_https_only
    CHECK (git_url LIKE 'https://%'),

  CONSTRAINT ai_recipe_sources_path_prefix_safe
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

CREATE INDEX IF NOT EXISTS ai_recipe_sources_status_idx
  ON ai_recipe_sources (sync_status);

-- ---------------------------------------------------------------------------
-- 2. ai_recipes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES ai_recipe_sources(id) ON DELETE CASCADE,
  file_path       text NOT NULL,

  title           text NOT NULL,
  description     text,
  instructions    text NOT NULL,
  parameters      jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_schema jsonb,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  sub_recipe_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  extensions      jsonb NOT NULL DEFAULT '[]'::jsonb,

  parse_status         text NOT NULL CHECK (parse_status IN ('ok','refused','parse_error')),
  unsupported_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,

  content_hash    text NOT NULL,
  last_commit_sha text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, file_path)
);

CREATE INDEX IF NOT EXISTS ai_recipes_source_idx ON ai_recipes (source_id);
CREATE INDEX IF NOT EXISTS ai_recipes_parse_status_idx
  ON ai_recipes (parse_status) WHERE parse_status <> 'ok';

-- ---------------------------------------------------------------------------
-- 3. ai_recipe_runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_recipe_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- recipe_id is nullable so the audit row survives when the recipe is
  -- deleted (sync removes the recipe; we keep the snapshotted hash +
  -- file_path so the run remains diagnosable).
  recipe_id             uuid REFERENCES ai_recipes(id) ON DELETE SET NULL,
  recipe_file_path      text,
  recipe_content_hash   text NOT NULL,

  user_id               uuid REFERENCES auth.users(id),
  use_case              text NOT NULL REFERENCES ai_use_cases(id),
  host_kind             text,
  host_id               text,

  params                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','complete','failed','cancelled','budget_blocked')),
  failure_reason        text,
  final_output          jsonb,
  -- per-step audit; written incrementally as the run progresses. shape:
  -- [{ step_id, step_index, status, provider?, model?, cost_micro_usd,
  --    duration_ms, usage_event_id?, error? }]
  steps                 jsonb NOT NULL DEFAULT '[]'::jsonb,

  total_cost_micro_usd  bigint NOT NULL DEFAULT 0,
  total_input_tokens    integer NOT NULL DEFAULT 0,
  total_output_tokens   integer NOT NULL DEFAULT 0,

  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  duration_ms           integer
);

CREATE INDEX IF NOT EXISTS ai_recipe_runs_recipe_idx ON ai_recipe_runs (recipe_id);
CREATE INDEX IF NOT EXISTS ai_recipe_runs_use_case_started_idx
  ON ai_recipe_runs (use_case, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_recipe_runs_status_idx
  ON ai_recipe_runs (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ai_recipe_runs_user_idx
  ON ai_recipe_runs (user_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 4. ai_recipe_memory  (per-run KV for `builtin: memory` tool — §4.10)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_recipe_memory (
  recipe_run_id   uuid NOT NULL REFERENCES ai_recipe_runs(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  written_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_run_id, key),
  CONSTRAINT ai_recipe_memory_key_grammar
    CHECK (key ~ '^[a-zA-Z_][a-zA-Z0-9_]{0,127}$')
);

-- ---------------------------------------------------------------------------
-- 5. ai_usage_events backref
-- ---------------------------------------------------------------------------

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS recipe_run_id uuid REFERENCES ai_recipe_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipe_step_index integer;

CREATE INDEX IF NOT EXISTS ai_usage_events_recipe_run_idx
  ON ai_usage_events (recipe_run_id) WHERE recipe_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. ai_use_cases — pinning a recipe source for a use-case (mirrors 008's
--    skill_source_id / skill_path columns).
-- ---------------------------------------------------------------------------

ALTER TABLE ai_use_cases
  ADD COLUMN IF NOT EXISTS recipe_source_id uuid REFERENCES ai_recipe_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipe_file_path text;

-- ---------------------------------------------------------------------------
-- 7. ai_recipe_source_webhook_log — mirrors ai_skill_source_webhook_log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_recipe_source_webhook_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid REFERENCES ai_recipe_sources(id) ON DELETE CASCADE,
  received_at     timestamptz NOT NULL DEFAULT now(),
  remote_addr     inet,
  provider        text NOT NULL,
  event_type      text,
  status          text NOT NULL,
  status_reason   text,
  payload_size    integer,
  signature_valid boolean
);

CREATE INDEX IF NOT EXISTS ai_recipe_source_webhook_log_received_idx
  ON ai_recipe_source_webhook_log (source_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------

ALTER TABLE ai_recipe_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_recipe_sources_read_admin ON ai_recipe_sources;
CREATE POLICY ai_recipe_sources_read_admin ON ai_recipe_sources
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS ai_recipe_sources_write_admin ON ai_recipe_sources;
CREATE POLICY ai_recipe_sources_write_admin ON ai_recipe_sources
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_recipes_read_admin ON ai_recipes;
CREATE POLICY ai_recipes_read_admin ON ai_recipes
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_recipe_runs ENABLE ROW LEVEL SECURITY;

-- Admin sees all runs; the creating user can read their own rows.
DROP POLICY IF EXISTS ai_recipe_runs_read_owner_or_admin ON ai_recipe_runs;
CREATE POLICY ai_recipe_runs_read_owner_or_admin ON ai_recipe_runs
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS ai_recipe_runs_write_admin ON ai_recipe_runs;
CREATE POLICY ai_recipe_runs_write_admin ON ai_recipe_runs
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_recipe_memory ENABLE ROW LEVEL SECURITY;

-- Memory rows are admin-only; ai_recipe_memory is internal to the runner.
DROP POLICY IF EXISTS ai_recipe_memory_admin ON ai_recipe_memory;
CREATE POLICY ai_recipe_memory_admin ON ai_recipe_memory
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

ALTER TABLE ai_recipe_source_webhook_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_recipe_source_webhook_log_read_admin ON ai_recipe_source_webhook_log;
CREATE POLICY ai_recipe_source_webhook_log_read_admin ON ai_recipe_source_webhook_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

-- ---------------------------------------------------------------------------
-- 9. updated_at trigger on ai_recipe_sources
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ai_recipe_sources_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_recipe_sources_updated_at_trigger ON ai_recipe_sources;
CREATE TRIGGER ai_recipe_sources_updated_at_trigger
  BEFORE UPDATE ON ai_recipe_sources
  FOR EACH ROW EXECUTE FUNCTION ai_recipe_sources_set_updated_at();
