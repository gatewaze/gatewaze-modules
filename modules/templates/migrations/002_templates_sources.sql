-- ============================================================================
-- Migration: templates_002_sources
-- Description: Source ingest tables. Three input shapes (git, upload, inline)
--              converge on the same parser and the same definitions tables
--              (see migration 001). Each definition row has at most one
--              owning source via templates_source_artifacts.
--              Drift previews live in templates_source_previews.
--              See spec-templates-module.md §5.3 and §6.
-- ============================================================================

-- ==========================================================================
-- 1. templates_sources
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.templates_sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id               uuid NOT NULL REFERENCES public.templates_libraries(id) ON DELETE CASCADE,
  kind                     text NOT NULL CHECK (kind IN ('git', 'upload', 'inline')),
  label                    text NOT NULL,
  status                   text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'errored')),

  -- git fields (kind='git')
  url                      text,
  branch                   text,
  token_secret_ref         text,                 -- pointer; never the raw token
  manifest_path            text DEFAULT 'gatewaze-template.json',
  installed_git_sha        text,                 -- 40-char hex; pinned to last-applied SHA
  available_git_sha        text,                 -- non-null when upstream has drifted
  last_checked_at          timestamptz,
  last_check_error         text,
  last_check_duration_ms   integer,
  auto_apply               boolean NOT NULL DEFAULT false,

  -- upload fields (kind='upload')
  upload_blob_ref          text,                 -- pointer to original file in object storage
  upload_sha               text,                 -- SHA-256 hex of the upload contents

  -- inline fields (kind='inline')
  inline_html              text,
  inline_sha               text,                 -- SHA-256 hex of inline_html

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,                 -- platform user id; non-FK by convention (platform user lives in auth schema)

  -- Per-kind required-field constraints. Postgres CHECK with CASE for clarity.
  CONSTRAINT templates_sources_git_fields CHECK (
    kind <> 'git' OR (url IS NOT NULL AND length(url) > 0)
  ),
  CONSTRAINT templates_sources_upload_fields CHECK (
    kind <> 'upload' OR (upload_blob_ref IS NOT NULL AND upload_sha IS NOT NULL)
  ),
  CONSTRAINT templates_sources_inline_fields CHECK (
    kind <> 'inline' OR (inline_html IS NOT NULL AND inline_sha IS NOT NULL)
  ),
  -- Length and shape sanity for the SHA fields (40-char hex for git, 64-char hex for SHA-256).
  CONSTRAINT templates_sources_installed_git_sha_format CHECK (
    installed_git_sha IS NULL OR installed_git_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT templates_sources_available_git_sha_format CHECK (
    available_git_sha IS NULL OR available_git_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT templates_sources_upload_sha_format CHECK (
    upload_sha IS NULL OR upload_sha ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT templates_sources_inline_sha_format CHECK (
    inline_sha IS NULL OR inline_sha ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS templates_sources_library_idx
  ON public.templates_sources (library_id);

CREATE INDEX IF NOT EXISTS templates_sources_kind_status_idx
  ON public.templates_sources (kind, status)
  WHERE status <> 'paused';

CREATE INDEX IF NOT EXISTS templates_sources_drift_idx
  ON public.templates_sources (last_checked_at NULLS FIRST)
  WHERE kind = 'git' AND status <> 'paused';

COMMENT ON TABLE public.templates_sources IS
  'Source-of-record for definitions: git repo, uploaded HTML, or inline fragment. Spec §5.3.';

COMMENT ON COLUMN public.templates_sources.token_secret_ref IS
  'Pointer into the platform secrets store. The raw token MUST NEVER be persisted here in cleartext.';

CREATE TRIGGER templates_sources_set_updated_at
  BEFORE UPDATE ON public.templates_sources
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

-- ==========================================================================
-- 2. templates_source_artifacts
-- ==========================================================================
-- Maps each definition row back to the source that produced it. A single
-- source can produce many artifacts (the definitions, wrappers, blocks,
-- bricks parsed from one repo / upload / fragment).

CREATE TABLE IF NOT EXISTS public.templates_source_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES public.templates_sources(id) ON DELETE CASCADE,
  artifact_kind   text NOT NULL CHECK (artifact_kind IN ('definition', 'wrapper', 'block_def', 'brick_def', 'asset')),
  artifact_id     uuid NOT NULL,         -- semantic FK; the target table depends on artifact_kind
  source_path     text,                  -- path inside repo/upload/fragment that yielded this artifact
  source_sha      text NOT NULL,         -- 40-char (git) or 64-char (sha-256) hex
  applied_at      timestamptz NOT NULL DEFAULT now(),
  detached_at     timestamptz,           -- soft-delete sentinel (artifact removed from later source apply)
  CONSTRAINT templates_source_artifacts_unique
    UNIQUE (source_id, artifact_kind, artifact_id)
);

CREATE INDEX IF NOT EXISTS templates_source_artifacts_source_idx
  ON public.templates_source_artifacts (source_id);

CREATE INDEX IF NOT EXISTS templates_source_artifacts_artifact_idx
  ON public.templates_source_artifacts (artifact_kind, artifact_id);

COMMENT ON TABLE public.templates_source_artifacts IS
  'Reverse lookup from definition rows to their owning source. Spec §5.3.';

-- ==========================================================================
-- 3. templates_source_previews
-- ==========================================================================
-- The drift-monitor worker computes a change preview when a git source
-- advances and stores it here. The admin UI renders the preview without
-- redoing the parse.

CREATE TABLE IF NOT EXISTS public.templates_source_previews (
  source_id          uuid PRIMARY KEY REFERENCES public.templates_sources(id) ON DELETE CASCADE,
  preview            jsonb NOT NULL,                 -- structured diff: added, removed, modified, breaking
  computed_at        timestamptz NOT NULL DEFAULT now(),
  computed_for_sha   text NOT NULL                   -- 40-char hex
    CHECK (computed_for_sha ~ '^[0-9a-f]{40}$')
);

COMMENT ON TABLE public.templates_source_previews IS
  'Cached change preview computed by the drift-monitor worker. Spec §6.5.';
