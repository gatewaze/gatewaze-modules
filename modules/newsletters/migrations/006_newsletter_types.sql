-- ============================================================================
-- Module: newsletters
-- Migration: 006_newsletter_types
-- Description: Extend template collections to function as newsletter types.
--              Each collection can be linked to a subscription list and have
--              its own sender identity.
-- ============================================================================

-- Add list_id FK to link newsletter type to a subscription list
ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS list_id uuid;

-- Add sender identity fields
ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS from_name text,
  ADD COLUMN IF NOT EXISTS from_email text,
  ADD COLUMN IF NOT EXISTS reply_to text;

-- Add FK constraint if lists table exists (lists module may not be installed yet)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'lists') THEN
    -- Only add if not already present
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'fk_newsletter_collections_list'
      AND table_name = 'newsletters_template_collections'
    ) THEN
      ALTER TABLE public.newsletters_template_collections
        ADD CONSTRAINT fk_newsletter_collections_list
        FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE SET NULL;
    END IF;
  END IF;
END
$$;

-- Add collection_id to newsletters_editions if not present
-- (editions should be tied to a newsletter type)
ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS collection_id uuid;

-- Add FK if no FK on collection_id exists yet (avoid duplicates)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'newsletters_editions'::regclass
    AND contype = 'f'
    AND conname LIKE '%collection%'
  ) THEN
    ALTER TABLE public.newsletters_editions
      ADD CONSTRAINT fk_editions_collection
      FOREIGN KEY (collection_id) REFERENCES public.newsletters_template_collections(id) ON DELETE SET NULL;
  END IF;
END
$$;
