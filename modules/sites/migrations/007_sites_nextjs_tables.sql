-- ============================================================================
-- Migration: sites_007_nextjs_tables
-- Description: New tables backing the Next.js theme path. Per
--              spec-sites-theme-kinds §8.1.
--                - pages_nextjs_drafts        (per (page_id, editor_id))
--                - pages_content_variants     (per-field personalization)
--                - pages_content_versions     (append-only published-content history)
--                - sites_publish_jobs         (git-driven publish state machine)
--                - sites_webhook_seen         (replay protection)
--                - sites_runtime_api_keys     (per-site dual-key auth)
--              Plus RLS policies and the canonical_jsonb helper.
-- ============================================================================

-- Required helper: pgcrypto for sha256(). Supabase installs extensions
-- in the `extensions` schema, not `public`, so unqualified `digest()` calls
-- fail under non-superuser roles whose search_path doesn't include
-- `extensions`. Install/move into `extensions` defensively, then reference
-- `extensions.digest()` everywhere below.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ==========================================================================
-- canonical_jsonb(value jsonb) — recursively sort object keys, used for
-- stable hashing of variants' match_context. Per spec §8.1 note.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.canonical_jsonb(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  k text;
  v jsonb;
  out jsonb := '{}'::jsonb;
  arr jsonb := '[]'::jsonb;
  item jsonb;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p) = 'object' THEN
    FOR k IN SELECT key FROM jsonb_each(p) ORDER BY key LOOP
      out := out || jsonb_build_object(k, public.canonical_jsonb(p->k));
    END LOOP;
    RETURN out;
  ELSIF jsonb_typeof(p) = 'array' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(p) LOOP
      arr := arr || jsonb_build_array(public.canonical_jsonb(item));
    END LOOP;
    RETURN arr;
  ELSE
    RETURN p;
  END IF;
END;
$$;

-- ==========================================================================
-- 1. pages_nextjs_drafts
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.pages_nextjs_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id           uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  editor_id         uuid NOT NULL,                 -- platform user id
  content           jsonb NOT NULL,                -- conforms to schema_version's schema
  base_commit_sha   text,                          -- captured when draft was loaded; nullable for first-ever draft
  schema_version    integer NOT NULL,              -- the templates_content_schemas.version this draft is against
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, editor_id),
  CONSTRAINT pages_nextjs_drafts_base_commit_format CHECK (
    base_commit_sha IS NULL OR base_commit_sha ~ '^[0-9a-f]{40}$'
  )
);

CREATE INDEX IF NOT EXISTS pages_nextjs_drafts_page_idx     ON public.pages_nextjs_drafts (page_id);
CREATE INDEX IF NOT EXISTS pages_nextjs_drafts_editor_idx   ON public.pages_nextjs_drafts (editor_id);

CREATE TRIGGER pages_nextjs_drafts_set_updated_at
  BEFORE UPDATE ON public.pages_nextjs_drafts
  FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();

-- ==========================================================================
-- 2. pages_content_variants
-- ==========================================================================
-- Per-field personalization variants. The match_context_hash is a
-- GENERATED column from canonical_jsonb(match_context) so duplicate
-- semantically-equal contexts can't co-exist (§7.6.0 / §8.1).

CREATE TABLE IF NOT EXISTS public.pages_content_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id             uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  field_path          text NOT NULL,
  match_context       jsonb NOT NULL,
  match_context_hash  text GENERATED ALWAYS AS (encode(extensions.digest(canonical_jsonb(match_context)::text, 'sha256'), 'hex')) STORED,
  content             jsonb NOT NULL,
  variant_label       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, field_path, match_context_hash)
);

CREATE INDEX IF NOT EXISTS pages_content_variants_page_field_idx
  ON public.pages_content_variants (page_id, field_path);

-- GIN index supports the §7.6 eligibility filter
-- ("variant.match_context @> request.context") in O(log n) time even at
-- > 50 variants per page.
CREATE INDEX IF NOT EXISTS pages_content_variants_match_context_gin
  ON public.pages_content_variants USING gin (match_context jsonb_path_ops);

-- updated_at bump trigger — used in §7.6 tiebreaker for variant precedence
CREATE TRIGGER pages_content_variants_set_updated_at
  BEFORE UPDATE ON public.pages_content_variants
  FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();

-- ==========================================================================
-- 3. pages_content_versions (append-only)
-- ==========================================================================
-- One row per successful publish of a page. Enables rollback and runtime
-- API serving of historical snapshots.

CREATE TABLE IF NOT EXISTS public.pages_content_versions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id                uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  version                integer NOT NULL CHECK (version >= 1),    -- mirrors pages.published_version at write time
  content                jsonb NOT NULL,                            -- snapshot at this version
  source_commit_sha      text,                                      -- nullable for non-git pages
  source_publish_job_id  uuid,                                      -- FK added below; ON DELETE SET NULL
  published_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, version),
  CONSTRAINT pages_content_versions_commit_format CHECK (
    source_commit_sha IS NULL OR source_commit_sha ~ '^[0-9a-f]{40}$'
  )
);

CREATE INDEX IF NOT EXISTS pages_content_versions_page_idx
  ON public.pages_content_versions (page_id, version DESC);

-- ==========================================================================
-- 4. sites_publish_jobs
-- ==========================================================================
-- Git-driven publish state machine. Per §6.4.

CREATE TABLE IF NOT EXISTS public.sites_publish_jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id                  uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  site_id                  uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  publisher_id             text NOT NULL,
  base_commit_sha          text,
  branch                   text,
  branch_strategy          text NOT NULL CHECK (branch_strategy IN ('direct', 'pull_request', 'content_branch')),
  draft_content_snapshot   jsonb NOT NULL,                          -- captured at queue time; copied to pages.content on finalize
  draft_schema_version     integer NOT NULL,                        -- which schema version the draft was authored against
  status                   text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued','preparing','committing','awaiting_build','build_started',
      'finalizing','succeeded','build_failed','cancelled','conflict','failed','finalization_failed'
    )),
  status_detail            jsonb,
  files                    jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{ path, content_hash }]
  result_commit_sha        text,
  result_pr_url            text,
  result_pr_number         integer,
  result_deployment_id     text,
  result_deployment_url    text,
  error                    text,
  log_object_key           text,
  log_truncated_tail       text,
  started_at               timestamptz,
  finished_at              timestamptz,
  debounce_until           timestamptz,
  heartbeat_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  CONSTRAINT sites_publish_jobs_base_commit_format CHECK (
    base_commit_sha IS NULL OR base_commit_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT sites_publish_jobs_result_commit_format CHECK (
    result_commit_sha IS NULL OR result_commit_sha ~ '^[0-9a-f]{40}$'
  )
);

CREATE INDEX IF NOT EXISTS sites_publish_jobs_page_status_idx
  ON public.sites_publish_jobs (page_id, status);

CREATE INDEX IF NOT EXISTS sites_publish_jobs_site_status_idx
  ON public.sites_publish_jobs (site_id, status);

-- For §6.5 webhook matching — primary key (publisher_id, deployment_id)
CREATE INDEX IF NOT EXISTS sites_publish_jobs_publisher_deployment_idx
  ON public.sites_publish_jobs (publisher_id, result_deployment_id)
  WHERE result_deployment_id IS NOT NULL;

-- For §6.5 fallback match by commit
CREATE INDEX IF NOT EXISTS sites_publish_jobs_publisher_commit_idx
  ON public.sites_publish_jobs (publisher_id, result_commit_sha)
  WHERE result_commit_sha IS NOT NULL;

-- For §6.5 fallback match by PR number
CREATE INDEX IF NOT EXISTS sites_publish_jobs_publisher_pr_idx
  ON public.sites_publish_jobs (publisher_id, result_pr_number)
  WHERE result_pr_number IS NOT NULL;

-- For the orphaned-queued sweeper (§7.4.6 in the sites spec, mirrored here)
CREATE INDEX IF NOT EXISTS sites_publish_jobs_orphaned_queued_idx
  ON public.sites_publish_jobs (debounce_until)
  WHERE status = 'queued';

-- For the stuck-running sweeper
CREATE INDEX IF NOT EXISTS sites_publish_jobs_stuck_running_idx
  ON public.sites_publish_jobs (heartbeat_at NULLS FIRST)
  WHERE status IN ('preparing','committing','awaiting_build','build_started','finalizing','cancelling');

CREATE TRIGGER sites_publish_jobs_set_updated_at
  BEFORE UPDATE ON public.sites_publish_jobs
  FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();

-- Allowed-transitions trigger. Constraint on status changes; raises on
-- illegal transitions. Mirrors the §6.4 state machine exactly.
CREATE OR REPLACE FUNCTION public.sites_publish_jobs_check_transition()
RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  CASE OLD.status
    WHEN 'queued'        THEN allowed := NEW.status IN ('preparing','cancelled','failed');
    WHEN 'preparing'     THEN allowed := NEW.status IN ('committing','cancelled','failed','conflict');
    WHEN 'committing'    THEN allowed := NEW.status IN ('awaiting_build','cancelled','failed','conflict');
    WHEN 'awaiting_build' THEN allowed := NEW.status IN ('build_started','failed','cancelled');
    WHEN 'build_started' THEN allowed := NEW.status IN ('finalizing','build_failed','cancelled');
    WHEN 'finalizing'    THEN allowed := NEW.status IN ('succeeded','finalization_failed');
    WHEN 'finalization_failed' THEN allowed := NEW.status IN ('finalizing','failed');
    -- Terminal states: succeeded, build_failed, cancelled, conflict, failed
    ELSE allowed := false;
  END CASE;

  IF NOT allowed THEN
    RAISE EXCEPTION 'sites_publish_jobs: illegal transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sites_publish_jobs_check_transition
  BEFORE UPDATE OF status ON public.sites_publish_jobs
  FOR EACH ROW EXECUTE FUNCTION public.sites_publish_jobs_check_transition();

-- Now backfill the FK from pages_content_versions.source_publish_job_id
ALTER TABLE public.pages_content_versions
  ADD CONSTRAINT pages_content_versions_publish_job_fkey
  FOREIGN KEY (source_publish_job_id)
  REFERENCES public.sites_publish_jobs(id)
  ON DELETE SET NULL;

-- ==========================================================================
-- 5. sites_webhook_seen — replay protection
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.sites_webhook_seen (
  publisher_id   text NOT NULL,
  deployment_id  text NOT NULL,
  event_kind     text NOT NULL,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publisher_id, deployment_id, event_kind)
);

CREATE INDEX IF NOT EXISTS sites_webhook_seen_seen_at_idx
  ON public.sites_webhook_seen (seen_at);

-- ==========================================================================
-- 6. sites_runtime_api_keys — per-site dual-key auth
-- ==========================================================================
-- Per spec §9.0. Each site has at most two active keys (primary, secondary).
-- Keys are stored hashed (HMAC-SHA256 with platform pepper); the cleartext
-- is shown to the admin once at creation time.

CREATE TABLE IF NOT EXISTS public.sites_runtime_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  slot          text NOT NULL CHECK (slot IN ('primary', 'secondary')),
  key_prefix    text NOT NULL,                   -- 'gw_runtime_<site_id_short>_'; first ~24 chars; NOT secret, displayable
  key_hash      text NOT NULL UNIQUE,            -- HMAC-SHA256 of full key with platform pepper; 64-char hex
  rate_limit_rps integer NOT NULL DEFAULT 100 CHECK (rate_limit_rps > 0),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz,                     -- set when this key was promoted from secondary to primary
  revoked_at    timestamptz,                     -- soft-revoke; row stays for audit
  CONSTRAINT sites_runtime_api_keys_hash_format CHECK (
    key_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS sites_runtime_api_keys_site_idx
  ON public.sites_runtime_api_keys (site_id, slot)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sites_runtime_api_keys_lookup_idx
  ON public.sites_runtime_api_keys (key_hash)
  WHERE revoked_at IS NULL;

-- Enforce at most one active key per (site_id, slot)
CREATE UNIQUE INDEX IF NOT EXISTS sites_runtime_api_keys_unique_active_slot
  ON public.sites_runtime_api_keys (site_id, slot)
  WHERE revoked_at IS NULL;

COMMENT ON COLUMN public.sites_runtime_api_keys.key_prefix IS
  'Cleartext prefix shown in admin UI for identification (e.g. "gw_runtime_aaif_a1b2c3..."). NOT a secret.';

COMMENT ON COLUMN public.sites_runtime_api_keys.key_hash IS
  'HMAC-SHA256(full_key, platform_pepper). Cleartext key is displayed once at creation; never stored.';

-- ==========================================================================
-- 7. RLS policies for the new tables
-- ==========================================================================

ALTER TABLE public.pages_nextjs_drafts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages_content_variants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages_content_versions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_publish_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_webhook_seen         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_runtime_api_keys     ENABLE ROW LEVEL SECURITY;

-- pages_nextjs_drafts: an editor reads their own drafts on sites they can edit;
-- site admins read any draft on their site (for the "stale draft cleanup" UI).
CREATE POLICY "pages_nextjs_drafts_self_or_admin_read"
  ON public.pages_nextjs_drafts FOR SELECT
  TO authenticated
  USING (
    editor_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.pages p
       WHERE p.id = page_id
         AND p.host_kind = 'site'
         AND public.can_admin_site(p.host_id)
    )
  );

-- pages_content_variants: same access model as page_blocks (cascade through
-- page access). Authenticated readers AND anon-on-published.
CREATE POLICY "pages_content_variants_via_page"
  ON public.pages_content_variants FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pages p WHERE p.id = page_id
       AND (
         public.can_view_page(p.host_kind, p.host_id)
         OR (p.status = 'published' AND public.published_page_anon_visible(p.host_kind, p.host_id))
       )
  ));

CREATE POLICY "pages_content_variants_anon_published"
  ON public.pages_content_variants FOR SELECT
  TO anon
  USING (EXISTS (
    SELECT 1 FROM public.pages p WHERE p.id = page_id
       AND p.status = 'published'
       AND public.published_page_anon_visible(p.host_kind, p.host_id)
  ));

-- pages_content_versions: site admins read; service-role only writes
CREATE POLICY "pages_content_versions_admin_read"
  ON public.pages_content_versions FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pages p WHERE p.id = page_id
       AND p.host_kind = 'site' AND public.can_admin_site(p.host_id)
  ));

-- sites_publish_jobs: site admins read
CREATE POLICY "sites_publish_jobs_admin_read"
  ON public.sites_publish_jobs FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id));

-- sites_webhook_seen: service role only — NO SELECT policy, RLS denies authenticated reads
-- (No policy block needed.)

-- sites_runtime_api_keys: site admins read METADATA only (key_prefix, slot,
-- created_at, rate_limit_rps, revoked_at). The key_hash is sensitive and the
-- cleartext key is never stored. The handler projects only the metadata
-- columns; RLS doesn't filter columns, so the API layer is responsible.
CREATE POLICY "sites_runtime_api_keys_admin_read"
  ON public.sites_runtime_api_keys FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id));
