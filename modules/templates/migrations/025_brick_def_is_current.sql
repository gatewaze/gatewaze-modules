-- ============================================================================
-- 025_brick_def_is_current — add is_current to templates_brick_defs
-- ============================================================================
--
-- Migration 024 (`prune_absent_block_defs`) redefined `templates_apply_source`
-- to soft-deactivate stale bricks via `UPDATE templates_brick_defs SET
-- is_current = false WHERE br.block_def_id = ... AND br.is_current = true`,
-- but the column had never been added to `templates_brick_defs` (block_defs
-- gained it in 014 but bricks were forgotten). On localhost an Update + re-
-- apply trips:
--
--   column br.is_current does not exist
--
-- Add the column, default existing rows to TRUE so they remain active, and
-- index the (block_def_id, is_current) lookup the RPC uses on every apply.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.templates_brick_defs
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS templates_brick_defs_block_def_current_idx
  ON public.templates_brick_defs (block_def_id, is_current)
  WHERE is_current = true;

COMMENT ON COLUMN public.templates_brick_defs.is_current IS
  'Active version flag. Mirrors the block_def equivalent: re-applies and prunes flip stale rows to FALSE rather than DELETE so already-sent editions keep resolving their FK.';
