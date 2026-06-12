-- ============================================================================
-- 022_block_def_declarative_render_kind — allow render_kind='declarative'
-- ============================================================================
--
-- The declarative block format (an html-ish SCHEMA + allowlisted tags that the
-- editor/publish path interprets into react-email) shipped for bricks in
-- migration 021, but the templates_block_defs CHECK constraints from 018 still
-- only permitted 'mustache' | 'react-email'. As a result sync-declarative-blocks
-- silently failed to flip blocks to declarative (the UPDATE violated the
-- constraint), so git-authored declarative blocks never took effect.
--
-- Extend both block-def constraints to accept 'declarative', which — like
-- 'react-email' — carries a component_id (the registry/key the renderer
-- resolves).
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.templates_block_defs
  DROP CONSTRAINT IF EXISTS templates_block_defs_render_kind_check;
ALTER TABLE public.templates_block_defs
  ADD CONSTRAINT templates_block_defs_render_kind_check
  CHECK (render_kind IN ('mustache', 'react-email', 'declarative'));

ALTER TABLE public.templates_block_defs
  DROP CONSTRAINT IF EXISTS templates_block_defs_render_kind_component_id;
ALTER TABLE public.templates_block_defs
  ADD CONSTRAINT templates_block_defs_render_kind_component_id
  CHECK (
    (render_kind IN ('react-email', 'declarative') AND component_id IS NOT NULL AND length(component_id) > 0)
    OR
    (render_kind = 'mustache' AND component_id IS NULL)
  );

COMMENT ON COLUMN public.templates_block_defs.render_kind IS
  'Editor + publish render path: mustache (html + renderTemplate) | react-email (TSX component_id from the email-blocks registry) | declarative (html-ish SCHEMA+tags interpreted into react-email).';
