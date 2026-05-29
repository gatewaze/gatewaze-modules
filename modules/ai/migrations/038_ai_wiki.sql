-- ============================================================================
-- Module: ai
-- Migration: 038_ai_wiki
-- Description: Wiki layer for the AI module (spec-ai-memory-wiki.md). Per-use-case
--              hierarchical markdown knowledge base: durable, searchable
--              (FTS + pgvector), bidirectionally git-synced, with an immutable
--              raw-source layer and an opt-in cross-use-case graph. Opt-in per
--              use case via the 'wiki' MCP extension; zero impact otherwise.
-- ============================================================================

-- pgvector gate (spec §14). Fails fast if the role can't create the extension;
-- on self-hosted Supabase, enable pgvector first. Hosted hybrid search needs it;
-- the local Goose backend (§5.8) does not.
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- ai_wiki_page — LLM-authored synthesis pages (spec §4.1). slug is a PATH.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_wiki_page (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case        text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  slug            text NOT NULL,                 -- path-namespaced, url-safe (§4.5)
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  summary         text,
  category        text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- parsed YAML frontmatter, queryable
  kind            text NOT NULL DEFAULT 'page'
                    CHECK (kind IN ('page', 'index', 'log')),

  -- search
  search_tsv      tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce(body, '')), 'C')
                  ) STORED,
  embedding       vector(1536),                  -- dim PINNED to text-embedding-3-small
  embedding_model text,
  embedded_at     timestamptz,
  content_hash    text NOT NULL,                 -- sha256(title||\n||body)

  -- provenance + concurrency + bidirectional sync
  version         integer NOT NULL DEFAULT 1,    -- per-page optimistic lock
  change_seq      bigint NOT NULL DEFAULT 0,     -- per-use-case git-sync watermark
  source          text NOT NULL DEFAULT 'model'
                    CHECK (source IN ('model', 'human', 'import')),
  git_synced_hash text,                          -- content_hash last reconciled with git
  conflict        boolean NOT NULL DEFAULT false,
  conflict_detail jsonb,

  written_by_message_id uuid REFERENCES public.ai_messages(id) ON DELETE SET NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT ai_wiki_page_use_case_slug_uniq UNIQUE (use_case, slug)
);

CREATE INDEX IF NOT EXISTS ai_wiki_page_tsv_idx
  ON public.ai_wiki_page USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS ai_wiki_page_embed_idx
  ON public.ai_wiki_page USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ai_wiki_page_meta_idx
  ON public.ai_wiki_page USING gin (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS ai_wiki_page_use_case_idx
  ON public.ai_wiki_page (use_case) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_wiki_page_conflict_idx
  ON public.ai_wiki_page (use_case) WHERE conflict;

-- ----------------------------------------------------------------------------
-- ai_wiki_link — link graph, DERIVED by parsing page bodies (spec §4.2).
-- Cross-wiki links carry a different to_use_case; raw links use 'raw:'||use_case.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_wiki_link (
  from_use_case text NOT NULL,
  from_slug     text NOT NULL,
  to_use_case   text NOT NULL,
  to_slug       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_use_case, from_slug, to_use_case, to_slug),
  FOREIGN KEY (from_use_case, from_slug)
    REFERENCES public.ai_wiki_page (use_case, slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_wiki_link_to_idx
  ON public.ai_wiki_link (to_use_case, to_slug);

-- ----------------------------------------------------------------------------
-- ai_wiki_sync_state — one row per use case; bidirectional git sync (spec §4.3).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_wiki_sync_state (
  use_case         text PRIMARY KEY REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  git_remote       text,
  git_branch       text NOT NULL DEFAULT 'main',
  -- push (DB → git)
  seq_counter      bigint NOT NULL DEFAULT 0,
  synced_seq       bigint NOT NULL DEFAULT 0,
  pending_seq      bigint NOT NULL DEFAULT 0,
  last_commit_sha  text,
  -- pull (git → DB)
  pull_enabled     boolean NOT NULL DEFAULT true,
  last_pulled_sha  text,
  webhook_secret   text,
  -- shared
  last_synced_at   timestamptz,
  last_error       text,
  conflict_count   integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- ai_wiki_grant — cross-use-case read/write grants (spec §4.6).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_wiki_grant (
  grantee_use_case text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  grantor_use_case text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  can_read         boolean NOT NULL DEFAULT true,
  can_write        boolean NOT NULL DEFAULT false,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grantee_use_case, grantor_use_case)
);

-- ----------------------------------------------------------------------------
-- ai_wiki_raw_source — immutable Karpathy raw/ layer (spec §4.7). Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_wiki_raw_source (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case      text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  source_type   text NOT NULL
                  CHECK (source_type IN ('url', 'upload', 'paste', 'connector')),
  uri           text,
  connector     text,
  title         text,
  content       text NOT NULL,
  content_hash  text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding     vector(1536),
  embedded_at   timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  expired_at    timestamptz,
  CONSTRAINT ai_wiki_raw_source_uniq UNIQUE (use_case, slug, content_hash)
);

CREATE INDEX IF NOT EXISTS ai_wiki_raw_use_case_idx
  ON public.ai_wiki_raw_source (use_case) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_wiki_raw_embed_idx
  ON public.ai_wiki_raw_source USING hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------------------
-- updated_at touch triggers (mirrors ai_memory).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_ai_wiki_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_wiki_page_touch_updated_at
  BEFORE UPDATE ON public.ai_wiki_page
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_wiki_updated_at();

CREATE TRIGGER ai_wiki_sync_state_touch_updated_at
  BEFORE UPDATE ON public.ai_wiki_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_wiki_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — authenticated SELECT, service_role ALL (mirrors ai_memory). Cross-wiki
-- read grants are enforced in-query by the MCP server (service_role), not RLS.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ai_wiki_page ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_wiki_page_select_authenticated ON public.ai_wiki_page
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_wiki_page_service_role_all ON public.ai_wiki_page
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.ai_wiki_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_wiki_link_select_authenticated ON public.ai_wiki_link
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_wiki_link_service_role_all ON public.ai_wiki_link
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.ai_wiki_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_wiki_sync_state_select_authenticated ON public.ai_wiki_sync_state
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_wiki_sync_state_service_role_all ON public.ai_wiki_sync_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.ai_wiki_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_wiki_grant_select_authenticated ON public.ai_wiki_grant
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_wiki_grant_service_role_all ON public.ai_wiki_grant
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.ai_wiki_raw_source ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_wiki_raw_source_select_authenticated ON public.ai_wiki_raw_source
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_wiki_raw_source_service_role_all ON public.ai_wiki_raw_source
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_wiki_page IS
  'LLM-authored wiki synthesis pages (path-slugged, FTS + pgvector, bidirectional git sync). spec-ai-memory-wiki.md §4.1.';
COMMENT ON TABLE public.ai_wiki_link IS
  'Wiki link graph, derived by parsing page bodies; cross-wiki + raw links. spec-ai-memory-wiki.md §4.2.';
COMMENT ON TABLE public.ai_wiki_sync_state IS
  'Per-use-case bidirectional git sync state (push watermark + pull cursor). spec-ai-memory-wiki.md §4.3.';
COMMENT ON TABLE public.ai_wiki_grant IS
  'Cross-use-case wiki read/write grants. spec-ai-memory-wiki.md §4.6.';
COMMENT ON TABLE public.ai_wiki_raw_source IS
  'Immutable raw-source layer (Karpathy raw/); model summarises but never edits. spec-ai-memory-wiki.md §4.7.';
