-- Add setup_complete flag to newsletters (template collections).
-- Prevents edition creation until newsletter is fully configured.
-- Mark all existing collections as complete (they're already configured).

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS setup_complete boolean DEFAULT false;

UPDATE public.newsletters_template_collections
SET setup_complete = true
WHERE setup_complete IS NULL OR setup_complete = false;
