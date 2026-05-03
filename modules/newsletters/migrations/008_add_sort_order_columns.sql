-- Add sort_order columns to edition blocks and bricks tables.
-- The editor code uses sort_order but the original migration created block_order/brick_order.
-- Add sort_order and copy existing values.

ALTER TABLE public.newsletters_edition_blocks
  ADD COLUMN IF NOT EXISTS sort_order integer;

UPDATE public.newsletters_edition_blocks
SET sort_order = block_order
WHERE sort_order IS NULL AND block_order IS NOT NULL;

ALTER TABLE public.newsletters_edition_bricks
  ADD COLUMN IF NOT EXISTS sort_order integer;

UPDATE public.newsletters_edition_bricks
SET sort_order = brick_order
WHERE sort_order IS NULL AND brick_order IS NOT NULL;

NOTIFY pgrst, 'reload schema';
