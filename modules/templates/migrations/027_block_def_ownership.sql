-- ============================================================================
-- Migration: templates_027_block_def_ownership
-- Description: Module ownership + feature gating for block definitions.
--              Per spec-broadcasts-blocks.md §4.2 / §5.1.
--
-- A block-def may be OWNED by a module: it is only offered in a builder's
-- palette when that module is enabled and (optionally) the operator holds a
-- feature. This is the tag that gates AVAILABILITY — it is not a separate code
-- path. Core/generic defs (header, footer, content_section, richtext) leave
-- both columns NULL and are always available.
--
-- Populated by git ingestion in a later migration that teaches
-- templates_apply_source to carry these fields; adding the columns here is
-- safe (both default NULL) and lets consuming builders + broadcast_blocks
-- denormalization reference them.
-- ============================================================================

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS owner_module     text,   -- module id that owns/gates this def; NULL = core/always-available
  ADD COLUMN IF NOT EXISTS required_feature text;   -- optional finer gate; NULL = module-enabled is enough

COMMENT ON COLUMN public.templates_block_defs.owner_module IS
  'Module id that owns/gates this block-def. NULL = core (always available). A builder offers this def only when owner_module is enabled. Per spec-broadcasts-blocks §4.2.';
COMMENT ON COLUMN public.templates_block_defs.required_feature IS
  'Optional finer gate: a feature the operator must hold for this def to be offered, on top of owner_module being enabled. NULL = module-enabled is sufficient.';

-- Partial index: only owned defs need module-scoped lookups; core defs are the
-- common case and stay out of the index.
CREATE INDEX IF NOT EXISTS templates_block_defs_owner
  ON public.templates_block_defs (owner_module)
  WHERE owner_module IS NOT NULL;
