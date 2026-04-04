-- Add content_category column to events table.
-- Categories are configured platform-wide in platform_settings (key: content_categories).
-- Stores the category slug (e.g. 'foundation', 'member', 'community').

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_events_content_category ON public.events (content_category);
