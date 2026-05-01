-- ============================================================================
-- Migration: templates_003_ab
-- Description: Built-in A/B engine tables. The IAbEngine interface is the
--              JS contract; these tables back the 'builtin' implementation.
--              Sub-modules (ab-optimizely, ab-growthbook) implement the
--              interface separately and may not write here.
--              See spec-templates-module.md §7.5.
-- ============================================================================

-- ==========================================================================
-- 1. templates_ab_tests
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.templates_ab_tests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind         text NOT NULL CHECK (scope_kind IN ('page', 'block_instance', 'edition', 'layout')),
  scope_id           uuid NOT NULL,                 -- semantic FK; target depends on scope_kind
  host_kind          text NOT NULL,                 -- denormalised for permission helpers
  host_id            uuid,                          -- nullable for platform-wide hosts
  name               text NOT NULL,
  variants           jsonb NOT NULL,                -- [{ key, weight }, ...]; weights sum to 100
  goal_event         text NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'paused', 'concluded')),
  engine_id          text NOT NULL DEFAULT 'builtin',
  external_test_id   text,                          -- nullable; populated by adapter sub-modules
  started_at         timestamptz,
  ended_at           timestamptz,
  winner_variant     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid
);

CREATE INDEX IF NOT EXISTS templates_ab_tests_scope_idx
  ON public.templates_ab_tests (scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS templates_ab_tests_host_idx
  ON public.templates_ab_tests (host_kind, host_id);

CREATE INDEX IF NOT EXISTS templates_ab_tests_status_idx
  ON public.templates_ab_tests (status)
  WHERE status = 'running';

CREATE TRIGGER templates_ab_tests_set_updated_at
  BEFORE UPDATE ON public.templates_ab_tests
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

-- ==========================================================================
-- 2. templates_ab_assignments
-- ==========================================================================
-- Per-viewer variant assignment. Used by the 'builtin' engine; external
-- engines may leave these tables empty and own assignment themselves.

CREATE TABLE IF NOT EXISTS public.templates_ab_assignments (
  test_id      uuid NOT NULL REFERENCES public.templates_ab_tests(id) ON DELETE CASCADE,
  session_key  text NOT NULL,                       -- anonymised stable per-viewer key
  variant      text NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_id, session_key)
);

-- ==========================================================================
-- 3. templates_ab_events
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.templates_ab_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       uuid NOT NULL REFERENCES public.templates_ab_tests(id) ON DELETE CASCADE,
  session_key   text NOT NULL,
  variant       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('impression', 'conversion')),
  goal_event    text,                                -- nullable (for impressions)
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  properties    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS templates_ab_events_test_kind_idx
  ON public.templates_ab_events (test_id, kind);

CREATE INDEX IF NOT EXISTS templates_ab_events_test_session_idx
  ON public.templates_ab_events (test_id, session_key);

CREATE INDEX IF NOT EXISTS templates_ab_events_occurred_at_idx
  ON public.templates_ab_events (occurred_at DESC);
