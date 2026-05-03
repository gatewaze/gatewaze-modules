-- Add content_category to newsletters_editions table.

ALTER TABLE public.newsletters_editions ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_newsletters_editions_content_category ON public.newsletters_editions (content_category);
