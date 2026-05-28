-- ============================================================================
-- Module: surveys
-- Migration: 001_surveys_tables
-- Description: Survey tables for survey schema and submission management
-- ============================================================================

-- ==========================================================================
-- 1. Survey schemas
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.surveys_schemas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id       varchar(255) NOT NULL,
  name            varchar(500) NOT NULL,
  description     text,
  version         varchar(50) NOT NULL DEFAULT '1.0',
  schema          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.surveys_schemas IS 'Survey definitions with schema and question configuration';

CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_schemas_survey_id
  ON public.surveys_schemas (survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_schemas_is_active
  ON public.surveys_schemas (is_active);

CREATE TRIGGER surveys_schemas_updated_at
  BEFORE UPDATE ON public.surveys_schemas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. Survey submissions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.surveys_submissions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id                 varchar(255) NOT NULL,
  user_id                   uuid,
  user_email                varchar(255) NOT NULL,
  responses                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  completion_time_seconds   integer,
  user_agent                text,
  referrer                  text,
  event_name                text,
  query_parameters          jsonb,
  is_partial                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.surveys_submissions IS 'Individual survey responses from users';

CREATE INDEX IF NOT EXISTS idx_surveys_submissions_survey_id
  ON public.surveys_submissions (survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_submissions_user_email
  ON public.surveys_submissions (user_email);
CREATE INDEX IF NOT EXISTS idx_surveys_submissions_created_at
  ON public.surveys_submissions (created_at DESC);

CREATE TRIGGER surveys_submissions_updated_at
  BEFORE UPDATE ON public.surveys_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. RLS
-- ==========================================================================
ALTER TABLE public.surveys_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surveys_submissions ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "surveys_schemas_select" ON public.surveys_schemas FOR SELECT TO authenticated USING (true);
CREATE POLICY "surveys_submissions_select" ON public.surveys_submissions FOR SELECT TO authenticated USING (true);

-- INSERT: admin for schemas, open for submissions
CREATE POLICY "surveys_schemas_insert" ON public.surveys_schemas FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "surveys_submissions_insert" ON public.surveys_submissions FOR INSERT TO authenticated WITH CHECK (true);

-- UPDATE/DELETE: admin only
CREATE POLICY "surveys_schemas_update" ON public.surveys_schemas FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "surveys_schemas_delete" ON public.surveys_schemas FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "surveys_submissions_update" ON public.surveys_submissions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "surveys_submissions_delete" ON public.surveys_submissions FOR DELETE TO authenticated USING (public.is_admin());
