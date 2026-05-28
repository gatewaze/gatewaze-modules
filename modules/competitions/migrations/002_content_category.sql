-- Add content_category to events_competitions table.

ALTER TABLE public.events_competitions ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_events_competitions_content_category ON public.events_competitions (content_category);
