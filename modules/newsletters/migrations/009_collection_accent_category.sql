-- Add accent_color and content_category to template collections.
-- accent_color tints the hero header gradient for each newsletter type.
-- content_category auto-applies to editions created from this collection.

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS accent_color varchar(7) DEFAULT '#00a2c7';

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS content_category varchar(100);
