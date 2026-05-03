-- ============================================================================
-- Module: newsletters
-- Migration: 012_gdoc_import
-- Description: Google Docs newsletter import — job tracking table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletter_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  google_folder_id TEXT,
  google_doc_id TEXT,
  import_type TEXT NOT NULL DEFAULT 'single' CHECK (import_type IN ('single', 'batch')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_docs INTEGER DEFAULT 0,
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  results JSONB DEFAULT '[]'::jsonb,
  config JSONB DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_import_jobs_collection
  ON public.newsletter_import_jobs(collection_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_import_jobs_status
  ON public.newsletter_import_jobs(status);

ALTER TABLE public.newsletter_import_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'newsletter_import_jobs' AND policyname = 'auth_all_newsletter_import_jobs'
  ) THEN
    CREATE POLICY "auth_all_newsletter_import_jobs"
      ON public.newsletter_import_jobs FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE TRIGGER newsletter_import_jobs_updated_at
  BEFORE UPDATE ON public.newsletter_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
