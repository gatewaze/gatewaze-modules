-- ============================================================================
-- Module: broadcasts
-- Migration: 005_broadcasts_category_list
-- Description: Tie every broadcast to a list for unsubscribe (unified list-tied
-- sending model). A broadcast now carries a category_list_id — the list it is
-- "sent as part of" — and recipients unsubscribe from THAT list (shared generic
-- list-unsubscribe), replacing the old free-text suppression_topic +
-- broadcast_suppressions model. The audience can still be a segment OR a list;
-- when it is a list, that list is the natural default category.
-- ============================================================================

ALTER TABLE public.broadcast_sends
  ADD COLUMN IF NOT EXISTS category_list_id uuid REFERENCES public.lists(id);

-- Backfill: list-audience broadcasts default their category to the audience list.
UPDATE public.broadcast_sends
SET category_list_id = ((list_ids)[1])::uuid
WHERE category_list_id IS NULL
  AND audience_type = 'list'
  AND array_length(list_ids, 1) >= 1;

COMMENT ON COLUMN public.broadcast_sends.category_list_id IS
  'List this broadcast is sent as part of; the unsubscribe target (per-list, shared with newsletters). Audience (who) is segment_id or list_ids; this is the unsubscribe category.';
