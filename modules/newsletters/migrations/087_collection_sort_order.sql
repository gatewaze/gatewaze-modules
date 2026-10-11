-- ============================================================================
-- Module: newsletters
-- Migration: 087_collection_sort_order
-- Description: Let publications be ordered explicitly. The admin dashboard and
-- the portal both listed them alphabetically; now they order by sort_order
-- (then name), and the dashboard lets a super_admin move a publication up or
-- down. Backfilled from the existing alphabetical order so nothing moves until
-- someone reorders.
-- ============================================================================
ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- Backfill: current alphabetical position, spaced by 10 so a later insert can
-- slot between neighbours without renumbering everything.
WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY name, created_at) AS rn
  FROM public.newsletters_template_collections
)
UPDATE public.newsletters_template_collections c
SET sort_order = r.rn * 10
FROM ranked r
WHERE r.id = c.id AND c.sort_order = 0;

CREATE INDEX IF NOT EXISTS newsletters_template_collections_sort_idx
  ON public.newsletters_template_collections (sort_order, name);
