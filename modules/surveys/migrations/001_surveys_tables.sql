-- Surveys Module: Core Tables
-- Migration: 001_surveys_tables.sql

-- 1. Surveys
CREATE TABLE IF NOT EXISTS public.module_surveys (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft', -- draft, active, closed
  questions jsonb DEFAULT '[]'::jsonb,
  settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Survey responses
CREATE TABLE IF NOT EXISTS public.module_survey_responses (
  id bigserial PRIMARY KEY,
  survey_id bigint NOT NULL REFERENCES public.module_surveys(id) ON DELETE CASCADE,
  respondent_email text,
  respondent_name text,
  answers jsonb DEFAULT '{}'::jsonb,
  submitted_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_survey_responses_survey ON public.module_survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_module_survey_responses_email ON public.module_survey_responses(respondent_email);

-- 3. RLS
ALTER TABLE public.module_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_survey_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_surveys" ON public.module_surveys FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_survey_responses" ON public.module_survey_responses FOR ALL TO authenticated USING (true) WITH CHECK (true);
