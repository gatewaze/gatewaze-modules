-- ============================================================================
-- Module: forms
-- Migration: 001_forms_tables
-- Description: Form definitions and submission management with people linkage
-- ============================================================================

-- ==========================================================================
-- 1. Forms definitions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.forms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            varchar(255) NOT NULL,
  name            varchar(500) NOT NULL,
  description     text,
  fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
  thank_you_message text NOT NULL DEFAULT 'Thank you for your submission!',
  is_active       boolean NOT NULL DEFAULT true,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.forms IS 'Form definitions with field schema and configuration';
COMMENT ON COLUMN public.forms.fields IS 'JSON array of field definitions: [{id, type, label, placeholder, required, options, ...}]';
COMMENT ON COLUMN public.forms.settings IS 'Additional form settings: {submitButtonText, redirectUrl, ...}';

CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_slug ON public.forms (slug);
CREATE INDEX IF NOT EXISTS idx_forms_is_active ON public.forms (is_active);

CREATE TRIGGER forms_updated_at
  BEFORE UPDATE ON public.forms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. Form submissions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.forms_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id         uuid NOT NULL REFERENCES public.forms(id) ON DELETE CASCADE,
  person_id       uuid REFERENCES public.people(id) ON DELETE SET NULL,
  responses       jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.forms_submissions IS 'Individual form submissions linked to people records';
COMMENT ON COLUMN public.forms_submissions.responses IS 'Field responses keyed by field ID: {field_id: value}';
COMMENT ON COLUMN public.forms_submissions.metadata IS 'Submission metadata: {user_agent, referrer, ip, source, ...}';

CREATE INDEX IF NOT EXISTS idx_forms_submissions_form_id ON public.forms_submissions (form_id);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_person_id ON public.forms_submissions (person_id);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_created_at ON public.forms_submissions (created_at DESC);

-- ==========================================================================
-- 3. RLS
-- ==========================================================================
ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms_submissions ENABLE ROW LEVEL SECURITY;

-- Forms: anon can read active forms (needed for portal + embeds), admin manages
CREATE POLICY "forms_select_anon" ON public.forms FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "forms_select_auth" ON public.forms FOR SELECT TO authenticated USING (true);
CREATE POLICY "forms_insert" ON public.forms FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "forms_update" ON public.forms FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "forms_delete" ON public.forms FOR DELETE TO authenticated USING (public.is_admin());

-- Submissions: anon can insert (public form submission), admin can read/manage
CREATE POLICY "forms_submissions_insert_anon" ON public.forms_submissions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "forms_submissions_insert_auth" ON public.forms_submissions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "forms_submissions_select" ON public.forms_submissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "forms_submissions_update" ON public.forms_submissions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "forms_submissions_delete" ON public.forms_submissions FOR DELETE TO authenticated USING (public.is_admin());

-- Service role bypass
CREATE POLICY "forms_service_all" ON public.forms FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "forms_submissions_service_all" ON public.forms_submissions FOR ALL TO service_role USING (true) WITH CHECK (true);
