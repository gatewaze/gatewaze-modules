-- ============================================================================
-- 097_gdoc_fill_jobs
-- ============================================================================
-- "Fill this edition from a Google Doc" runs in the background: reading a
-- doc and mapping it onto the blocks takes a minute or two, longer than a
-- proxy will hold a request open. The API records each run here, does the
-- work after replying, and the editor polls the row for the result.
--
-- The row holds the PROPOSAL only (the doc's content sorted into blocks);
-- nothing is applied to the edition until the author chooses what to keep
-- and saves. Rows older than 7 days are deleted when a new run starts.
-- Written only by the API (service role); an admin reads their own rows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletters_gdoc_fill_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id   uuid NOT NULL REFERENCES public.newsletters_editions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  source       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  proposal     jsonb,
  error_code   text,
  error        text,
  usage        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS newsletters_gdoc_fill_jobs_created_idx ON public.newsletters_gdoc_fill_jobs (created_at);

ALTER TABLE public.newsletters_gdoc_fill_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletters_gdoc_fill_jobs_own_read ON public.newsletters_gdoc_fill_jobs;
CREATE POLICY newsletters_gdoc_fill_jobs_own_read ON public.newsletters_gdoc_fill_jobs
  FOR SELECT TO authenticated USING (requested_by = (SELECT auth.uid()) AND (SELECT public.is_admin()));
REVOKE ALL ON public.newsletters_gdoc_fill_jobs FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON public.newsletters_gdoc_fill_jobs FROM anon, authenticated;
  GRANT SELECT ON public.newsletters_gdoc_fill_jobs TO authenticated;
  GRANT ALL ON public.newsletters_gdoc_fill_jobs TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
