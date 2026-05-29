-- ============================================================================
-- content-keywords module — schema (rev H)
-- See spec-content-keyword-rules.md
-- ============================================================================

-- Trusted role for SECURITY DEFINER functions (shared with content-triage).
-- BYPASSRLS so module-owned SECURITY DEFINER functions can read/write
-- governed content tables that have their own RLS policies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE gatewaze_module_writer BYPASSRLS;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $$;

-- ============================================================================
-- Helpers
-- ============================================================================

-- Canonicalize a text[] (sort + dedupe) using ASCII unit-separator U+001F so
-- equivalent sets hash to the same key regardless of order/punctuation.
CREATE OR REPLACE FUNCTION public.ck_canonical_text_array(arr text[])
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(x, E'\x1f' ORDER BY x)
  FROM (SELECT DISTINCT unnest(arr) AS x) t;
$$;

-- Set updated_at timestamp helper (already exists in most DBs but redefined idempotently).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN NEW.updated_at = now(); RETURN NEW; END $body$;
  END IF;
END $$;

-- ============================================================================
-- content_keyword_rules — central table operators edit
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description     text CHECK (char_length(description) <= 1000),

  -- Match definition
  pattern         text NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 500),
  pattern_type    text NOT NULL CHECK (pattern_type IN ('substring','word','regex')),
  case_sensitive  boolean NOT NULL DEFAULT false,
  locale          text,                               -- reserved; v1 leaves NULL

  -- Scoping (intersection: all conditions must hold)
  content_types   text[] NOT NULL CHECK (array_length(content_types, 1) >= 1),
  sources         text[],                             -- NULL = all sources
  fields          text[] NOT NULL DEFAULT ARRAY['any']
                  CHECK (array_length(fields, 1) >= 1
                         AND NOT ('any' = ANY(fields) AND array_length(fields, 1) > 1)),

  -- Lifecycle + optimistic concurrency
  is_active       boolean NOT NULL DEFAULT true,
  row_version     bigint  NOT NULL DEFAULT 1,

  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Per-rule metadata for external modules; tier_rank drives match_tier_rank
  -- (folded from 004_metadata_and_tier_rank).
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.content_keyword_rules OWNER TO gatewaze_module_writer;

CREATE INDEX IF NOT EXISTS idx_ckr_active_types
  ON public.content_keyword_rules USING GIN (content_types) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_ckr_active_sources
  ON public.content_keyword_rules USING GIN (sources)
  WHERE is_active AND sources IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ckr_unique_active_name
  ON public.content_keyword_rules (name, public.ck_canonical_text_array(content_types))
  WHERE is_active;

-- BEFORE INSERT/UPDATE: canonicalize array columns.
CREATE OR REPLACE FUNCTION public.ckr_canonicalize() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_types := ARRAY(SELECT DISTINCT unnest(NEW.content_types) ORDER BY 1);
  IF NEW.sources IS NOT NULL THEN
    NEW.sources := ARRAY(SELECT DISTINCT unnest(NEW.sources) ORDER BY 1);
  END IF;
  NEW.fields := ARRAY(SELECT DISTINCT unnest(NEW.fields) ORDER BY 1);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ckr_canonicalize_trg ON public.content_keyword_rules;
CREATE TRIGGER ckr_canonicalize_trg BEFORE INSERT OR UPDATE
  ON public.content_keyword_rules
  FOR EACH ROW EXECUTE FUNCTION public.ckr_canonicalize();

-- BEFORE UPDATE: bump updated_at + row_version.
CREATE OR REPLACE FUNCTION public.ckr_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ckr_before_update_trg ON public.content_keyword_rules;
CREATE TRIGGER ckr_before_update_trg BEFORE UPDATE
  ON public.content_keyword_rules
  FOR EACH ROW EXECUTE FUNCTION public.ckr_before_update();

-- ============================================================================
-- content_keyword_ruleset_versions — monotonic per content_type
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_ruleset_versions (
  content_type text PRIMARY KEY,
  version      bigint NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_keyword_ruleset_versions OWNER TO gatewaze_module_writer;

-- AFTER trigger on rules: bump versions only for visibility-affecting changes.
CREATE OR REPLACE FUNCTION public.ckr_bump_ruleset_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_types text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_types := NEW.content_types;
  ELSIF TG_OP = 'DELETE' THEN
    affected_types := OLD.content_types;
  ELSE
    IF NEW.pattern        IS NOT DISTINCT FROM OLD.pattern
       AND NEW.pattern_type   IS NOT DISTINCT FROM OLD.pattern_type
       AND NEW.case_sensitive IS NOT DISTINCT FROM OLD.case_sensitive
       AND NEW.content_types  IS NOT DISTINCT FROM OLD.content_types
       AND NEW.sources        IS NOT DISTINCT FROM OLD.sources
       AND NEW.fields         IS NOT DISTINCT FROM OLD.fields
       AND NEW.is_active      IS NOT DISTINCT FROM OLD.is_active
    THEN
      RETURN NEW;
    END IF;
    affected_types := ARRAY(SELECT DISTINCT unnest(OLD.content_types || NEW.content_types));
  END IF;

  INSERT INTO public.content_keyword_ruleset_versions (content_type, version)
  SELECT t, 1 FROM unnest(affected_types) AS t
  ON CONFLICT (content_type) DO UPDATE
    SET version = content_keyword_ruleset_versions.version + 1,
        updated_at = now();

  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS ckr_bump_ruleset_version_trg ON public.content_keyword_rules;
CREATE TRIGGER ckr_bump_ruleset_version_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.content_keyword_rules
  FOR EACH ROW EXECUTE FUNCTION public.ckr_bump_ruleset_version();

-- ============================================================================
-- content_keyword_adapters — registry
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_adapters (
  content_type    text PRIMARY KEY,
  text_fn         regprocedure NOT NULL,
  table_name      regclass NOT NULL,
  created_at_column text NOT NULL DEFAULT 'created_at',
  declared_fields text[] NOT NULL CHECK (array_length(declared_fields, 1) >= 1),
  declares_source boolean NOT NULL DEFAULT false,
  display_label   text NOT NULL,
  default_visible_when_no_rules boolean NOT NULL DEFAULT true,
  public_read_fns regprocedure[] NOT NULL DEFAULT ARRAY[]::regprocedure[],
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_keyword_adapters OWNER TO gatewaze_module_writer;

-- Adapter validation trigger: signature, ownership, declared_fields nonempty.
CREATE OR REPLACE FUNCTION public.ck_validate_adapter_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_owner text;
  v_signature text;
BEGIN
  -- text_fn signature: (uuid) RETURNS TABLE(field text, value text, source text)
  SELECT pg_get_userbyid(proowner), oidvectortypes(proargtypes)
    INTO v_owner, v_signature
    FROM pg_proc WHERE oid = NEW.text_fn::oid;
  IF v_owner <> 'gatewaze_module_writer' THEN
    RAISE EXCEPTION 'text_fn % must be owned by gatewaze_module_writer (found %)',
      NEW.text_fn, v_owner;
  END IF;
  IF v_signature <> 'uuid' THEN
    RAISE EXCEPTION 'text_fn % expected signature (uuid), got (%)', NEW.text_fn, v_signature;
  END IF;

  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ck_adapters_validate ON public.content_keyword_adapters;
CREATE TRIGGER ck_adapters_validate BEFORE INSERT OR UPDATE
  ON public.content_keyword_adapters
  FOR EACH ROW EXECUTE FUNCTION public.ck_validate_adapter_registration();

-- AFTER INSERT: seed ruleset_versions row.
CREATE OR REPLACE FUNCTION public.cka_seed_ruleset_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.content_keyword_ruleset_versions (content_type, version)
  VALUES (NEW.content_type, 1)
  ON CONFLICT (content_type) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cka_seed_ruleset_version_trg ON public.content_keyword_adapters;
CREATE TRIGGER cka_seed_ruleset_version_trg
  AFTER INSERT ON public.content_keyword_adapters
  FOR EACH ROW EXECUTE FUNCTION public.cka_seed_ruleset_version();

-- ============================================================================
-- content_keyword_item_state — derived per-item visibility
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_item_state (
  content_type     text NOT NULL,
  content_id       uuid NOT NULL,
  is_visible       boolean NOT NULL,
  matched_rule_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  evaluated_at     timestamptz NOT NULL DEFAULT now(),
  ruleset_version  bigint NOT NULL,
  -- Highest tier_rank across matched rules (folded from 004_metadata_and_tier_rank).
  match_tier_rank  int,
  PRIMARY KEY (content_type, content_id)
);
ALTER TABLE public.content_keyword_item_state OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_ckis_type_visible
  ON public.content_keyword_item_state (content_type, is_visible);
CREATE INDEX IF NOT EXISTS idx_ckis_stale
  ON public.content_keyword_item_state (content_type, ruleset_version);
CREATE INDEX IF NOT EXISTS idx_ckis_tier_rank
  ON public.content_keyword_item_state (content_type, match_tier_rank DESC NULLS LAST)
  WHERE is_visible;

-- ============================================================================
-- content_keyword_match_queue — DB-backed queue, drained by worker
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_match_queue (
  content_type     text NOT NULL,
  content_id       uuid NOT NULL,
  op               text NOT NULL CHECK (op IN ('evaluate','delete')),
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  PRIMARY KEY (content_type, content_id)
);
ALTER TABLE public.content_keyword_match_queue OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_ckmq_next_attempt
  ON public.content_keyword_match_queue (next_attempt_at, enqueued_at);

-- ============================================================================
-- content_keyword_match_queue_dlq — failed items needing manual triage
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_match_queue_dlq (
  content_type text NOT NULL,
  content_id   uuid NOT NULL,
  op           text NOT NULL,
  enqueued_at  timestamptz NOT NULL,
  attempts     int  NOT NULL,
  last_error   text,
  failed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_type, content_id)
);
ALTER TABLE public.content_keyword_match_queue_dlq OWNER TO gatewaze_module_writer;

-- ============================================================================
-- content_keyword_recompute_jobs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_recompute_jobs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger                   text NOT NULL CHECK (trigger IN ('rule_change','manual','adapter_install','backfill')),
  rule_ids                  uuid[],
  content_types             text[],
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','complete','complete_with_errors','failed','canceled')),
  rows_processed            bigint NOT NULL DEFAULT 0,
  rows_total_estimate       bigint,
  last_processed_created_at timestamptz,
  last_processed_id         uuid,
  error_message             text,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at                timestamptz,
  heartbeat_at              timestamptz,
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_keyword_recompute_jobs OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_ckrj_status ON public.content_keyword_recompute_jobs (status);

-- ============================================================================
-- content_keyword_recompute_leases — mutual exclusion via lease (not advisory locks)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_recompute_leases (
  content_type text PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES content_keyword_recompute_jobs(id) ON DELETE CASCADE,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
ALTER TABLE public.content_keyword_recompute_leases OWNER TO gatewaze_module_writer;

-- ============================================================================
-- content_keyword_eval_errors — audit trail for evaluator failures
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_eval_errors (
  id            bigserial PRIMARY KEY,
  content_type  text NOT NULL,
  content_id    uuid NOT NULL,
  rule_id       uuid,
  error_code    text NOT NULL,
  error_message text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_keyword_eval_errors OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_ckee_recent
  ON public.content_keyword_eval_errors (content_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ckee_rule
  ON public.content_keyword_eval_errors (rule_id) WHERE rule_id IS NOT NULL;

-- ============================================================================
-- content_keyword_adapter_stats — cached counts for /adapters API
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_keyword_adapter_stats (
  content_type           text PRIMARY KEY REFERENCES content_keyword_adapters(content_type) ON DELETE CASCADE,
  current_total_count    bigint NOT NULL DEFAULT 0,
  current_visible_count  bigint NOT NULL DEFAULT 0,
  stale_state_count      bigint NOT NULL DEFAULT 0,
  refreshed_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_keyword_adapter_stats OWNER TO gatewaze_module_writer;

-- ============================================================================
-- RLS policies
-- ============================================================================
ALTER TABLE public.content_keyword_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckr_service ON public.content_keyword_rules;
CREATE POLICY ckr_service ON public.content_keyword_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ckr_authd_read ON public.content_keyword_rules;
CREATE POLICY ckr_authd_read ON public.content_keyword_rules
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.content_keyword_adapters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cka_service ON public.content_keyword_adapters;
CREATE POLICY cka_service ON public.content_keyword_adapters
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS cka_read ON public.content_keyword_adapters;
CREATE POLICY cka_read ON public.content_keyword_adapters
  FOR SELECT TO authenticated, anon USING (true);

ALTER TABLE public.content_keyword_item_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckis_service ON public.content_keyword_item_state;
CREATE POLICY ckis_service ON public.content_keyword_item_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.content_keyword_match_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckmq_service ON public.content_keyword_match_queue;
CREATE POLICY ckmq_service ON public.content_keyword_match_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.content_keyword_match_queue_dlq ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckmq_dlq_service ON public.content_keyword_match_queue_dlq;
CREATE POLICY ckmq_dlq_service ON public.content_keyword_match_queue_dlq
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.content_keyword_recompute_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckrj_service ON public.content_keyword_recompute_jobs;
CREATE POLICY ckrj_service ON public.content_keyword_recompute_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ckrj_authd_read ON public.content_keyword_recompute_jobs;
CREATE POLICY ckrj_authd_read ON public.content_keyword_recompute_jobs
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.content_keyword_recompute_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckrl_service ON public.content_keyword_recompute_leases;
CREATE POLICY ckrl_service ON public.content_keyword_recompute_leases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.content_keyword_eval_errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckee_service ON public.content_keyword_eval_errors;
CREATE POLICY ckee_service ON public.content_keyword_eval_errors
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.content_keyword_adapter_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ckas_service ON public.content_keyword_adapter_stats;
CREATE POLICY ckas_service ON public.content_keyword_adapter_stats
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ckas_read ON public.content_keyword_adapter_stats;
CREATE POLICY ckas_read ON public.content_keyword_adapter_stats
  FOR SELECT TO authenticated USING (true);
