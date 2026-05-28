-- Add content_category to cohorts table.

ALTER TABLE public.cohorts ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_cohorts_content_category ON public.cohorts (content_category);
