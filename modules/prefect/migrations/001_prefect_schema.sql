-- ============================================================================
-- Migration: 001_prefect_schema.sql
-- Module: prefect-worker
-- Description: Bootstrap the `prefect` schema and the scoped agent roles
--              that the content-discovery pipeline uses.
--
-- This migration runs once per Supabase environment (local Supabase CLI,
-- cloud Supabase staging, cloud Supabase production). It is idempotent.
--
-- See: spec C.1.4 (Prefect Metadata Store) and A.8 (Agent Security Model)
--      in gatewaze-environments/specs/spec-content-discovery-pipeline.md
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. `prefect` schema
--
-- Prefect Server owns this schema fully via the `prefect_app` role. Its
-- Alembic migrations run on Server startup against this schema. We do NOT
-- enable RLS here — Prefect expects unrestricted ownership of its tables
-- and RLS would silently break its queries.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS prefect;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prefect_app') THEN
    -- Password is a placeholder. Set via `ALTER ROLE prefect_app WITH PASSWORD '...'`
    -- using the value from the SUPABASE_PREFECT_DB_PASSWORD secret at deploy time.
    EXECUTE 'CREATE ROLE prefect_app LOGIN PASSWORD ''change_me_via_secret''';
  END IF;
END $$;

GRANT USAGE, CREATE ON SCHEMA prefect TO prefect_app;
GRANT ALL ON ALL TABLES    IN SCHEMA prefect TO prefect_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA prefect TO prefect_app;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA prefect TO prefect_app;
-- ALTER DEFAULT PRIVILEGES requires one statement per object kind —
-- TABLES, SEQUENCES, and FUNCTIONS can't be comma-separated in a single
-- GRANT clause (Postgres parses the first as the kind and chokes on the
-- next "," with `syntax error at or near ","`).
ALTER DEFAULT PRIVILEGES IN SCHEMA prefect GRANT ALL ON TABLES    TO prefect_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA prefect GRANT ALL ON SEQUENCES TO prefect_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA prefect GRANT ALL ON FUNCTIONS TO prefect_app;

-- Explicitly deny cross-schema access (blast-radius isolation)
REVOKE ALL ON SCHEMA public  FROM prefect_app;
REVOKE ALL ON SCHEMA auth    FROM prefect_app;
REVOKE ALL ON SCHEMA storage FROM prefect_app;

-- ---------------------------------------------------------------------------
-- 2. `agent_reader` role — SELECT-only on pipeline tables
--
-- Used by the supabase_query custom MCP tool in the Python worker.
-- Connects via Supabase REST API using a JWT signed for this role
-- (SUPABASE_AGENT_READER_KEY).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_reader') THEN
    EXECUTE 'CREATE ROLE agent_reader NOLOGIN';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO agent_reader;

-- Pipeline tables — SELECT only
GRANT SELECT ON public.content_submissions        TO agent_reader;
GRANT SELECT ON public.content_queue              TO agent_reader;
GRANT SELECT ON public.content_items              TO agent_reader;
GRANT SELECT ON public.content_segments           TO agent_reader;
GRANT SELECT ON public.content_discovery_sources  TO agent_reader;
GRANT SELECT ON public.content_discovery_runs     TO agent_reader;
GRANT SELECT ON public.content_project_taxonomy   TO agent_reader;
GRANT SELECT ON public.content_topic_taxonomy     TO agent_reader;

-- Explicitly deny access to user data / auth / other schemas
REVOKE ALL ON SCHEMA auth    FROM agent_reader;
REVOKE ALL ON SCHEMA storage FROM agent_reader;
REVOKE ALL ON SCHEMA prefect FROM agent_reader;

-- ---------------------------------------------------------------------------
-- 3. `agent_writer` role — INSERT + narrow UPDATE on pipeline tables
--
-- Used by the supabase_insert_submission, supabase_upsert_queue, and
-- supabase_upsert_item custom MCP tools. The UPDATE grants are column-scoped
-- so a prompt-injected agent cannot rewrite arbitrary fields.
--
-- No DELETE. No TRUNCATE. No access to newsletters_* or user tables.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_writer') THEN
    EXECUTE 'CREATE ROLE agent_writer NOLOGIN';
  END IF;
END $$;

-- agent_writer inherits agent_reader's SELECT grants
GRANT agent_reader TO agent_writer;

GRANT USAGE ON SCHEMA public TO agent_writer;

-- INSERT on the four pipeline write targets
GRANT INSERT ON public.content_submissions TO agent_writer;
GRANT INSERT ON public.content_queue       TO agent_writer;
GRANT INSERT ON public.content_items       TO agent_writer;
GRANT INSERT ON public.content_segments    TO agent_writer;

-- Narrow UPDATE — only the columns the agent legitimately needs to change.
-- If additional columns become legitimately updateable, extend this grant in
-- a follow-up migration with review.
GRANT UPDATE (status, priority, processing_started_at) ON public.content_queue TO agent_writer;

-- Column names below must track the canonical schema in lf-modules
-- content-pipeline/001_content_pipeline_tables.sql. content_items has
-- `projects` (not projects_mentioned) and no top-level `status` —
-- status lives on content_queue. content_segments has `topics`, not
-- `tags`. Earlier revisions of this migration referenced renamed /
-- non-existent columns and reconcile failed with 42703.
GRANT UPDATE (
  summary,
  hot_take,
  quality_score,
  projects,
  topics
) ON public.content_items TO agent_writer;

GRANT UPDATE (summary, topics) ON public.content_segments TO agent_writer;

-- Sequences needed by INSERTs
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent_writer;

-- Explicitly deny DELETE/TRUNCATE and cross-schema access
REVOKE ALL ON SCHEMA auth    FROM agent_writer;
REVOKE ALL ON SCHEMA storage FROM agent_writer;
REVOKE ALL ON SCHEMA prefect FROM agent_writer;

-- ---------------------------------------------------------------------------
-- 4. Comments for operators
-- ---------------------------------------------------------------------------

COMMENT ON ROLE prefect_app  IS 'Owner of the prefect.* tables. Used by the Prefect Server process to persist flow/task run metadata.';
COMMENT ON ROLE agent_reader IS 'Read-only role for content pipeline tables. Used by the Claude Agent SDK supabase_query tool via a signed Supabase JWT.';
COMMENT ON ROLE agent_writer IS 'Insert-and-narrow-update role for content pipeline tables. Used by the Claude Agent SDK upsert/insert tools. Cannot DELETE, TRUNCATE, or access auth/newsletters/storage.';
