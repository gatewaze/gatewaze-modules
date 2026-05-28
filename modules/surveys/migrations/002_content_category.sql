-- Add content_category to survey_schemas table.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'survey_schemas') THEN
    ALTER TABLE public.survey_schemas ADD COLUMN IF NOT EXISTS content_category varchar(100);
    CREATE INDEX IF NOT EXISTS idx_survey_schemas_content_category ON public.survey_schemas (content_category);
  END IF;
END
$$;
