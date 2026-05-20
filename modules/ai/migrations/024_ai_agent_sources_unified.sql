-- Unify skill + recipe sources into a single ai_agent_sources row.
--
-- BEFORE: ai_skill_sources + ai_recipe_sources are parallel tables with
-- identical column shape. Adding a single agentskills.io/Goose-style
-- monorepo (one repo with `skills/` AND `recipes/` directories — the
-- canonical aaif layout) required creating TWO sources pointing at the
-- same git URL with a forked sync cadence and forked webhook secret.
--
-- AFTER: one ai_agent_sources row per repo. Sync walks both `skills/`
-- and `recipes/` in a single pass. Same webhook fires both indexers.
--
-- This is a dev-only platform — no data preservation guard. We drop
-- the old source tables (CASCADE wipes ai_skills and ai_recipes), and
-- rebuild the skill + recipe tables with FKs to ai_agent_sources.

-- ── Drop the two old source tables + child content tables ──────────
-- Order matters: drop content tables first to release FKs, then the
-- parents. CASCADE on the parents would normally cover the children
-- but a half-applied earlier attempt may have orphaned them, so we
-- drop everything explicitly.
DROP TABLE IF EXISTS public.ai_skill_source_webhook_log CASCADE;
DROP TABLE IF EXISTS public.ai_recipe_source_webhook_log CASCADE;
DROP TABLE IF EXISTS public.ai_skills CASCADE;
DROP TABLE IF EXISTS public.ai_recipes CASCADE;
DROP TABLE IF EXISTS public.ai_skill_sources CASCADE;
DROP TABLE IF EXISTS public.ai_recipe_sources CASCADE;

-- ── Unified agent sources ───────────────────────────────────────────
CREATE TABLE public.ai_agent_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  label                 text NOT NULL,
  description           text,

  git_url               text NOT NULL,
  branch                text NOT NULL DEFAULT 'main',
  -- Optional prefix scoping the sync walk (e.g. 'agents/' if skills/
  -- and recipes/ live under a nested directory). Empty string = walk
  -- from repo root.
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

  -- Counts updated after each successful sync — surfaces "what's in
  -- this repo" without a second query. Both numbers >= 0; zero is OK
  -- (a repo can be skills-only or recipes-only).
  skill_count           integer NOT NULL DEFAULT 0,
  recipe_count          integer NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),

  CONSTRAINT ai_agent_sources_https_only
    CHECK (git_url LIKE 'https://%'),

  CONSTRAINT ai_agent_sources_path_prefix_safe
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

CREATE INDEX ai_agent_sources_status_idx ON ai_agent_sources (sync_status);

COMMENT ON TABLE public.ai_agent_sources IS
  'Unified source for both agentskills.io skills and Goose recipes. Replaces ai_skill_sources + ai_recipe_sources. One repo = one row; sync walks both skills/ and recipes/.';

-- Updated_at trigger (mirrors what 009/014 did for the old tables).
CREATE OR REPLACE FUNCTION public.ai_agent_sources_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_agent_sources_updated_at ON public.ai_agent_sources;
CREATE TRIGGER ai_agent_sources_updated_at
  BEFORE UPDATE ON public.ai_agent_sources
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_sources_set_updated_at();

ALTER TABLE public.ai_agent_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_agent_sources_select_authenticated" ON public.ai_agent_sources;
CREATE POLICY "ai_agent_sources_select_authenticated"
  ON public.ai_agent_sources FOR SELECT TO authenticated USING (true);

-- ── Re-create ai_skills against the new source table ────────────────
-- Schema mirrors migration 013_ai_skills_agentskills_io.sql but with
-- source_id FK now pointing at ai_agent_sources.
CREATE TABLE public.ai_skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES public.ai_agent_sources(id) ON DELETE CASCADE,

  name            text NOT NULL,
  dir_path        text NOT NULL,

  description     text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  resources       jsonb NOT NULL DEFAULT '[]'::jsonb,

  body            text NOT NULL,
  body_chars      integer NOT NULL,
  content_hash    text NOT NULL,

  parse_status         text NOT NULL CHECK (parse_status IN ('ok','refused','parse_error')),
  unsupported_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Reference image (Phase-1 carryover for image-gen skills).
  reference_image_bytes bytea,
  reference_image_mime  text,

  last_commit_sha text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_skills_name_grammar
    CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT ai_skills_name_matches_dir
    CHECK (split_part(dir_path, '/', greatest(1, array_length(string_to_array(dir_path, '/'), 1))) = name),
  CONSTRAINT ai_skills_description_length CHECK (char_length(description) <= 1024),
  CONSTRAINT ai_skills_reference_image_both_or_neither
    CHECK (
      (reference_image_bytes IS NULL AND reference_image_mime IS NULL)
      OR (reference_image_bytes IS NOT NULL AND reference_image_mime IS NOT NULL)
    ),

  UNIQUE (source_id, dir_path)
);

CREATE INDEX ai_skills_source_idx ON public.ai_skills (source_id);
CREATE INDEX ai_skills_parse_status_idx ON public.ai_skills (parse_status) WHERE parse_status <> 'ok';
CREATE INDEX ai_skills_metadata_gin ON public.ai_skills USING gin (metadata jsonb_path_ops);
CREATE INDEX ai_skills_name_idx ON public.ai_skills (name);

ALTER TABLE public.ai_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skills_select_authenticated" ON public.ai_skills;
CREATE POLICY "ai_skills_select_authenticated"
  ON public.ai_skills FOR SELECT TO authenticated USING (true);

-- ── Re-create ai_recipes against the new source table ───────────────
-- Mirrors migration 014_ai_recipes.sql + 015 prompt/version columns.
CREATE TABLE public.ai_recipes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id            uuid NOT NULL REFERENCES public.ai_agent_sources(id) ON DELETE CASCADE,

  file_path            text NOT NULL,
  version              text,

  title                text NOT NULL,
  description          text,
  instructions         text NOT NULL,
  prompt               text,
  parameters           jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_schema      jsonb,
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  sub_recipe_refs      jsonb NOT NULL DEFAULT '[]'::jsonb,
  extensions           jsonb NOT NULL DEFAULT '[]'::jsonb,

  parse_status         text NOT NULL CHECK (parse_status IN ('ok','refused','parse_error')),
  unsupported_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,

  content_hash         text NOT NULL,
  last_commit_sha      text NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, file_path)
);

CREATE INDEX ai_recipes_source_idx ON public.ai_recipes (source_id);
CREATE INDEX ai_recipes_parse_status_idx ON public.ai_recipes (parse_status) WHERE parse_status <> 'ok';

ALTER TABLE public.ai_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_recipes_select_authenticated" ON public.ai_recipes;
CREATE POLICY "ai_recipes_select_authenticated"
  ON public.ai_recipes FOR SELECT TO authenticated USING (true);

-- ── Webhook log (unified) ───────────────────────────────────────────
CREATE TABLE public.ai_agent_source_webhook_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid REFERENCES public.ai_agent_sources(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  provider    text NOT NULL,
  -- 'ok' | 'rejected_signature' | 'rejected_branch' | 'rejected_unknown_source'
  outcome     text NOT NULL,
  commit_sha  text,
  ref         text,
  raw_event   jsonb
);

CREATE INDEX ai_agent_source_webhook_log_source_idx
  ON public.ai_agent_source_webhook_log (source_id, received_at DESC);

ALTER TABLE public.ai_agent_source_webhook_log ENABLE ROW LEVEL SECURITY;

-- ── ai_use_cases.skill_source_id FK ─────────────────────────────────
-- 008 declared the column as a soft ref. We make it match the new
-- ai_agent_sources name so ON DELETE SET NULL works when an operator
-- removes a source.
--
-- Any existing skill_source_id values point at the OLD ai_skill_sources
-- (now dropped) — wipe them BEFORE adding the FK so the constraint
-- can be added. Operators re-bind via the admin UI after creating the
-- new ai_agent_sources row. The chat widget's ConfiguredPromptBar
-- will show 'No prompt configured' (grey) until they do — clear signal
-- that re-binding is needed.
UPDATE public.ai_use_cases
  SET skill_source_id = NULL, skill_path = NULL
  WHERE skill_source_id IS NOT NULL;

ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_skill_source_fk;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_skill_source_fk
    FOREIGN KEY (skill_source_id) REFERENCES public.ai_agent_sources(id) ON DELETE SET NULL;
