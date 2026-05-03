-- Add block_template_id and brick_template_id FK columns to edition blocks/bricks tables.
-- The editor saves these but the original migration only had block_type/brick_type text columns.

-- Edition blocks: add block_template_id FK
ALTER TABLE public.newsletters_edition_blocks
  ADD COLUMN IF NOT EXISTS block_template_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'newsletters_edition_blocks'::regclass
    AND contype = 'f'
    AND conname LIKE '%block_template%'
  ) THEN
    ALTER TABLE public.newsletters_edition_blocks
      ADD CONSTRAINT fk_edition_blocks_template
      FOREIGN KEY (block_template_id) REFERENCES public.newsletters_block_templates(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Edition bricks: add brick_template_id FK
ALTER TABLE public.newsletters_edition_bricks
  ADD COLUMN IF NOT EXISTS brick_template_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'newsletters_edition_bricks'::regclass
    AND contype = 'f'
    AND conname LIKE '%brick_template%'
  ) THEN
    ALTER TABLE public.newsletters_edition_bricks
      ADD CONSTRAINT fk_edition_bricks_template
      FOREIGN KEY (brick_template_id) REFERENCES public.newsletters_brick_templates(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
