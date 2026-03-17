-- Cohorts Module: Core Tables
-- Migration: 001_cohorts_tables.sql

-- 1. Cohorts
CREATE TABLE IF NOT EXISTS public.module_cohorts (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft', -- draft, enrolling, active, completed
  start_date timestamptz,
  end_date timestamptz,
  max_enrollments integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Cohort sessions
CREATE TABLE IF NOT EXISTS public.module_cohort_sessions (
  id bigserial PRIMARY KEY,
  cohort_id bigint NOT NULL REFERENCES public.module_cohorts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  scheduled_at timestamptz,
  duration_minutes integer,
  location text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_cohort_sessions_cohort ON public.module_cohort_sessions(cohort_id);

-- 3. Cohort enrollments
CREATE TABLE IF NOT EXISTS public.module_cohort_enrollments (
  id bigserial PRIMARY KEY,
  cohort_id bigint NOT NULL REFERENCES public.module_cohorts(id) ON DELETE CASCADE,
  enrollee_email text NOT NULL,
  enrollee_name text,
  status text NOT NULL DEFAULT 'enrolled', -- enrolled, active, completed, dropped
  enrolled_at timestamptz DEFAULT now(),
  UNIQUE(cohort_id, enrollee_email)
);

CREATE INDEX IF NOT EXISTS idx_module_cohort_enrollments_cohort ON public.module_cohort_enrollments(cohort_id);

-- 4. RLS
ALTER TABLE public.module_cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_cohort_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_cohort_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_cohorts" ON public.module_cohorts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_cohort_sessions" ON public.module_cohort_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_cohort_enrollments" ON public.module_cohort_enrollments FOR ALL TO authenticated USING (true) WITH CHECK (true);
