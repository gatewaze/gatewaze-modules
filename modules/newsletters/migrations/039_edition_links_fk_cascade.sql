-- ============================================================================
-- Module: newsletters
-- Migration: 039_edition_links_fk_cascade
-- Description: Fix incompatible FK action + NOT NULL on
--              newsletters_edition_links.block_id.
--
-- Background:
--   migration 001 created the FK as
--     FOREIGN KEY (block_id) REFERENCES newsletters_edition_blocks(id)
--       ON DELETE SET NULL
--   migration 032 (link tracking) then promoted block_id to NOT NULL because
--   the new per-occurrence registry must always be attributable to a block.
--   The two rules contradict each other: any DELETE on a referenced block
--   tries to SET NULL on the dependent link rows, which immediately violates
--   the NOT NULL constraint and aborts the whole transaction with 23502.
--
--   This surfaces when the admin editor saves an edition — its current save
--   path deletes-then-reinserts edition_blocks rows, and the delete fails
--   the moment any tracked link row exists for the edition. Net effect:
--   publishing the edition is blocked.
--
-- Fix:
--   Switch the FK to ON DELETE CASCADE. The tracking-registry row is a
--   per-block artefact (block_type / field / link_index all describe the
--   parent block), so when the block goes the registry row goes with it.
--   Same shape as the brick_id FK already uses for similar reasons.
--
-- Idempotent: drops by name (always present since migration 001), re-creates
-- with the new action.
-- ============================================================================

ALTER TABLE public.newsletters_edition_links
  DROP CONSTRAINT IF EXISTS newsletters_edition_links_block_id_fkey;

ALTER TABLE public.newsletters_edition_links
  ADD CONSTRAINT newsletters_edition_links_block_id_fkey
  FOREIGN KEY (block_id)
  REFERENCES public.newsletters_edition_blocks(id)
  ON DELETE CASCADE;
