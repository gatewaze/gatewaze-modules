-- ============================================================================
-- 018_block_def_render_kind — discriminator for react-email blocks
-- ============================================================================
--
-- Per spec-builder-evaluation §3.6 (extended). The newsletter editor now
-- supports two render paths for email blocks:
--
--   render_kind='mustache'      — legacy: templates_block_defs.html is a
--                                 Mustache template; renderTemplate +
--                                 juice produces the final HTML.
--   render_kind='react-email'   — new: TSX component lives in the
--                                 admin/publish-worker code (registry by
--                                 component_id); @react-email/components
--                                 produces email-safe HTML directly.
--
-- Existing rows default to 'mustache' so no migration of Mustache email
-- blocks is required. New email blocks can opt into 'react-email' on a
-- per-block basis.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS render_kind text
    NOT NULL DEFAULT 'mustache'
    CHECK (render_kind IN ('mustache', 'react-email')),
  ADD COLUMN IF NOT EXISTS component_id text;

-- Sanity invariant: react-email blocks MUST identify a registry component
-- so the renderer can resolve the JSX. Mustache blocks should NOT have a
-- component_id set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'templates_block_defs_render_kind_component_id'
       AND conrelid = 'public.templates_block_defs'::regclass
  ) THEN
    ALTER TABLE public.templates_block_defs
      ADD CONSTRAINT templates_block_defs_render_kind_component_id
      CHECK (
        (render_kind = 'react-email' AND component_id IS NOT NULL AND length(component_id) > 0)
        OR
        (render_kind = 'mustache' AND component_id IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.templates_block_defs.render_kind IS
  'Editor + publish render path: mustache (templates_block_defs.html + renderTemplate) or react-email (TSX component_id resolved from the email-blocks registry). Per spec-builder-evaluation §3.6.';

COMMENT ON COLUMN public.templates_block_defs.component_id IS
  'When render_kind=react-email, the registry key for the TSX component (e.g. ''heading'', ''text'', ''button''). Resolved client-side via the email-blocks registry; resolved server-side by the publish-worker when calling @react-email/render.';
