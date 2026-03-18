-- ============================================================================
-- Module: cohorts
-- Migration: 001_cohorts_tables
-- Description: Cohort tables for course/training management including
--              instructor profiles, enrollments, resources, live sessions,
--              weeks, modules, benefits, testimonials, and user progress.
-- ============================================================================

-- ==========================================================================
-- 1. Instructor profiles
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_instructor_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid REFERENCES public.people (id) ON DELETE SET NULL,
  customer_cio_id   text,
  email             varchar(255) NOT NULL,
  bio               text,
  specialty         text,
  rating            numeric(3,2),
  total_students    integer DEFAULT 0,
  is_featured       boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cohorts_instructor_profiles IS 'Instructor profiles for cohort-based courses';

CREATE INDEX IF NOT EXISTS idx_cohorts_instructor_profiles_customer
  ON public.cohorts_instructor_profiles (person_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_instructor_profiles_email
  ON public.cohorts_instructor_profiles (email);

CREATE TRIGGER cohorts_instructor_profiles_updated_at
  BEFORE UPDATE ON public.cohorts_instructor_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. Cohorts
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   varchar(500) NOT NULL,
  description             text,
  long_description         text,
  instructor_id           uuid REFERENCES public.cohorts_instructor_profiles (id) ON DELETE SET NULL,
  start_date              date NOT NULL,
  end_date                date,
  price_cents             integer NOT NULL DEFAULT 0,
  original_price_cents    integer,
  max_participants        integer,
  rating                  numeric(3,2),
  tags                    text[],
  image                   text,
  is_active               boolean NOT NULL DEFAULT true,
  stripe_mode             varchar(10) DEFAULT 'test' CHECK (stripe_mode IN ('test', 'live')),
  google_classroom_link   text,
  modules_heading         text,
  modules_description     text,
  benefits_heading        text,
  testimonials_heading    text,
  why_heading             text,
  why_description         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cohorts IS 'Cohort-based training courses';

CREATE INDEX IF NOT EXISTS idx_cohorts_instructor   ON public.cohorts (instructor_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_is_active    ON public.cohorts (is_active);
CREATE INDEX IF NOT EXISTS idx_cohorts_start_date   ON public.cohorts (start_date DESC);

CREATE TRIGGER cohorts_updated_at
  BEFORE UPDATE ON public.cohorts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. Cohort weeks
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_weeks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  week_number     integer NOT NULL,
  title           varchar(500),
  description     text,
  start_date      date,
  end_date        date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, week_number)
);

CREATE INDEX IF NOT EXISTS idx_cohorts_weeks_cohort ON public.cohorts_weeks (cohort_id);

CREATE TRIGGER cohorts_weeks_updated_at
  BEFORE UPDATE ON public.cohorts_weeks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 4. Cohort modules
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_modules (
  id              serial PRIMARY KEY,
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  cohort_week_id  uuid REFERENCES public.cohorts_weeks (id) ON DELETE SET NULL,
  week            integer NOT NULL DEFAULT 1,
  title           varchar(500) NOT NULL,
  description     text NOT NULL DEFAULT '',
  topics          text[] DEFAULT '{}',
  module_order    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_modules_cohort ON public.cohorts_modules (cohort_id);

CREATE TRIGGER cohorts_modules_updated_at
  BEFORE UPDATE ON public.cohorts_modules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 5. Cohort enrollments
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_enrollments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id           uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  person_id           uuid REFERENCES public.people (id) ON DELETE SET NULL,
  user_id             uuid,
  amount_cents        integer NOT NULL DEFAULT 0,
  stripe_session_id   text,
  payment_status      varchar(20) NOT NULL DEFAULT 'pending'
                      CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cohorts_enrollments IS 'Student enrollments in cohorts with payment tracking';

CREATE INDEX IF NOT EXISTS idx_cohorts_enrollments_cohort    ON public.cohorts_enrollments (cohort_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_enrollments_customer  ON public.cohorts_enrollments (person_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_enrollments_status    ON public.cohorts_enrollments (payment_status);

CREATE TRIGGER cohorts_enrollments_updated_at
  BEFORE UPDATE ON public.cohorts_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 6. Cohort resources
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  module_id       integer REFERENCES public.cohorts_modules (id) ON DELETE SET NULL,
  week_number     integer NOT NULL DEFAULT 1,
  title           varchar(500) NOT NULL,
  description     text,
  resource_type   varchar(20) NOT NULL DEFAULT 'link'
                  CHECK (resource_type IN ('video', 'document', 'link', 'zoom', 'slack')),
  resource_url    text NOT NULL,
  is_member_only  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_resources_cohort ON public.cohorts_resources (cohort_id);

CREATE TRIGGER cohorts_resources_updated_at
  BEFORE UPDATE ON public.cohorts_resources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 7. Cohort live sessions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_live_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id         uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  module_id         integer REFERENCES public.cohorts_modules (id) ON DELETE SET NULL,
  week_number       integer NOT NULL DEFAULT 1,
  session_title     varchar(500) NOT NULL,
  session_date      timestamptz NOT NULL,
  session_end_date  timestamptz,
  timezone          varchar(100),
  zoom_link         text,
  recording_link    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_live_sessions_cohort ON public.cohorts_live_sessions (cohort_id);

CREATE TRIGGER cohorts_live_sessions_updated_at
  BEFORE UPDATE ON public.cohorts_live_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 8. Cohort benefits
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_benefits (
  id              serial PRIMARY KEY,
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  benefit         text NOT NULL,
  display_order   integer NOT NULL DEFAULT 0,
  benefit_order   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_benefits_cohort ON public.cohorts_benefits (cohort_id);

CREATE TRIGGER cohorts_benefits_updated_at
  BEFORE UPDATE ON public.cohorts_benefits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 9. Cohort testimonials
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_testimonials (
  id              serial PRIMARY KEY,
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  name            varchar(255) NOT NULL,
  role            varchar(255),
  content         text NOT NULL,
  rating          numeric(3,2),
  display_order   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_testimonials_cohort ON public.cohorts_testimonials (cohort_id);

CREATE TRIGGER cohorts_testimonials_updated_at
  BEFORE UPDATE ON public.cohorts_testimonials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 10. User progress tracking
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.cohorts_user_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  cohort_id       uuid NOT NULL REFERENCES public.cohorts (id) ON DELETE CASCADE,
  module_week     integer NOT NULL,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, cohort_id, module_week)
);

CREATE INDEX IF NOT EXISTS idx_cohorts_user_progress_user   ON public.cohorts_user_progress (user_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_user_progress_cohort ON public.cohorts_user_progress (cohort_id);

-- ==========================================================================
-- 11. RLS
-- ==========================================================================
ALTER TABLE public.cohorts_instructor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cohorts_user_progress ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "cohorts_instructor_profiles_select" ON public.cohorts_instructor_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_select" ON public.cohorts FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_weeks_select" ON public.cohorts_weeks FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_modules_select" ON public.cohorts_modules FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_enrollments_select" ON public.cohorts_enrollments FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_resources_select" ON public.cohorts_resources FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_live_sessions_select" ON public.cohorts_live_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_benefits_select" ON public.cohorts_benefits FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_testimonials_select" ON public.cohorts_testimonials FOR SELECT TO authenticated USING (true);
CREATE POLICY "cohorts_user_progress_select" ON public.cohorts_user_progress FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "cohorts_instructor_profiles_insert" ON public.cohorts_instructor_profiles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_instructor_profiles_update" ON public.cohorts_instructor_profiles FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_instructor_profiles_delete" ON public.cohorts_instructor_profiles FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_insert" ON public.cohorts FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_update" ON public.cohorts FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_delete" ON public.cohorts FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_weeks_insert" ON public.cohorts_weeks FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_weeks_update" ON public.cohorts_weeks FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_weeks_delete" ON public.cohorts_weeks FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_modules_insert" ON public.cohorts_modules FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_modules_update" ON public.cohorts_modules FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_modules_delete" ON public.cohorts_modules FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_enrollments_insert" ON public.cohorts_enrollments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_enrollments_update" ON public.cohorts_enrollments FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_enrollments_delete" ON public.cohorts_enrollments FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_resources_insert" ON public.cohorts_resources FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_resources_update" ON public.cohorts_resources FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_resources_delete" ON public.cohorts_resources FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_live_sessions_insert" ON public.cohorts_live_sessions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_live_sessions_update" ON public.cohorts_live_sessions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_live_sessions_delete" ON public.cohorts_live_sessions FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_benefits_insert" ON public.cohorts_benefits FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_benefits_update" ON public.cohorts_benefits FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_benefits_delete" ON public.cohorts_benefits FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_testimonials_insert" ON public.cohorts_testimonials FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "cohorts_testimonials_update" ON public.cohorts_testimonials FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "cohorts_testimonials_delete" ON public.cohorts_testimonials FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "cohorts_user_progress_insert" ON public.cohorts_user_progress FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "cohorts_user_progress_update" ON public.cohorts_user_progress FOR UPDATE TO authenticated USING (true);
CREATE POLICY "cohorts_user_progress_delete" ON public.cohorts_user_progress FOR DELETE TO authenticated USING (public.is_admin());
