-- ============================================================================
-- Migration: templates_021_brick_def_render_kind
-- Description: Brick defs gain render_kind + component_id (block defs already
--              have these via migration 018). Lets a brick be flagged
--              'declarative' (html-ish source interpreted into react-email) or
--              'react-email' (registry component), the same way blocks are, so
--              slot containers can resolve git-authored declarative bricks.
-- ============================================================================

ALTER TABLE public.templates_brick_defs
  ADD COLUMN IF NOT EXISTS render_kind text,
  ADD COLUMN IF NOT EXISTS component_id text;

COMMENT ON COLUMN public.templates_brick_defs.render_kind IS
  'How the brick renders: mustache | react-email | declarative. NULL = legacy mustache.';
COMMENT ON COLUMN public.templates_brick_defs.component_id IS
  'Registry component id for react-email/declarative bricks (defaults to key).';
