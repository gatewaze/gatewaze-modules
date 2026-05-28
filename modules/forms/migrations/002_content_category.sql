-- Add content_category to forms table.

ALTER TABLE public.forms ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_forms_content_category ON public.forms (content_category);
