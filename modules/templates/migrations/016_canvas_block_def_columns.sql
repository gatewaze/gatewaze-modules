-- ============================================================================
-- Migration: templates_016_canvas_block_def_columns
-- Description: Phase 1 schema additions for the WYSIWYG canvas builder, per
--              spec-sites-wysiwyg-builder.md §4.2 + §4.5.
--
--   - templates_block_defs.thumbnail_url   — palette UI (§4.2)
--   - templates_block_defs.canvas_validated — bool, true after the data-*
--     attribute parser pass succeeds at ingest (§4.5)
--   - templates_block_defs.canvas_validation_errors  — jsonb, errors from
--     the parser pass (NULL when canvas_validated=true)
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

COMMENT ON COLUMN public.templates_block_defs.thumbnail_url IS
  'Optional URL to a 200x120 PNG/SVG thumbnail shown in the canvas block palette. Resolved relative to the theme repo root or absolute URL. Set by theme authors via templates_apply_source.';

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS canvas_validated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.templates_block_defs.canvas_validated IS
  'True once the canvas template-validator has run against this block_def''s html and confirmed all data-field / data-children / data-asset / data-block-root attributes resolve correctly per spec-sites-wysiwyg-builder §4.5. False = the block_def cannot be used by the canvas (palette hides it; editor refuses to insert).';

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS canvas_validation_errors jsonb;

COMMENT ON COLUMN public.templates_block_defs.canvas_validation_errors IS
  'Array of {code, message, path?} objects when canvas_validated=false. NULL when canvas_validated=true. Surfaced to theme authors in the Source tab UI.';
