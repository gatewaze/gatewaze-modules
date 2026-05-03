-- ============================================================================
-- Migration: newsletters_020_link_to_templates_module
-- Description: Cutover to templates module for layout authoring.
--              Adds FK columns from newsletters_editions to templates module
--              tables (templates_libraries, templates_definitions). The
--              edition's old `template_id` column references the legacy
--              newsletters-only template tables; this migration adds the
--              path forward without dropping the old table immediately.
--
--              Application-code cutover follows in PR 16.b: workers and
--              admin UI switch from newsletters_block_templates →
--              templates_block_defs.
--
-- Per spec-templates-module §10 — "newsletter, blog_post, sites all share
-- the templates registry."
-- ============================================================================

-- ==========================================================================
-- 1. Add FK columns to newsletters_editions
-- ==========================================================================
-- These are nullable while the cutover is in flight. Once all editions are
-- migrated to templates_definitions, we'll add NOT NULL + drop the legacy
-- template_id column in a follow-up.

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS templates_library_id    uuid,
  ADD COLUMN IF NOT EXISTS templates_definition_id uuid;

-- FK constraints — DEFERRABLE so a single transaction can swap library +
-- definition together when the migration script lands.
ALTER TABLE public.newsletters_editions
  ADD CONSTRAINT newsletters_editions_templates_library_fk
    FOREIGN KEY (templates_library_id)
    REFERENCES public.templates_libraries(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.newsletters_editions
  ADD CONSTRAINT newsletters_editions_templates_definition_fk
    FOREIGN KEY (templates_definition_id)
    REFERENCES public.templates_definitions(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS newsletters_editions_templates_library_idx
  ON public.newsletters_editions (templates_library_id);
CREATE INDEX IF NOT EXISTS newsletters_editions_templates_definition_idx
  ON public.newsletters_editions (templates_definition_id);

-- ==========================================================================
-- 2. Add FK column to newsletters_edition_blocks for the templates_block_defs path
-- ==========================================================================
-- Block-level discriminator: an edition_block can come from either the
-- legacy newsletter block templates (block_template_id) OR from
-- templates_block_defs (templates_block_def_id). Both are nullable; rows
-- have exactly one set. App code checks which path is active.

ALTER TABLE public.newsletters_edition_blocks
  ADD COLUMN IF NOT EXISTS templates_block_def_id uuid;

ALTER TABLE public.newsletters_edition_blocks
  ADD CONSTRAINT newsletters_edition_blocks_templates_block_def_fk
    FOREIGN KEY (templates_block_def_id)
    REFERENCES public.templates_block_defs(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS newsletters_edition_blocks_templates_block_def_idx
  ON public.newsletters_edition_blocks (templates_block_def_id);

-- ==========================================================================
-- 3. Register newsletter as a pages_host so editions can opt into the
--    pages namespace later (cross-host phase 2 lands in PR 17).
-- ==========================================================================
-- Idempotent — only inserts if absent.

INSERT INTO public.pages_host_registrations (
  host_kind, module_id, url_prefix_template,
  can_admin_fn, can_edit_pages_fn, can_publish_fn,
  default_wrapper_key, accepted_theme_kinds, enabled
)
VALUES (
  'newsletter',
  'newsletters',
  '/newsletters/{host_id}',
  'public.is_admin()',
  'public.is_admin()',
  'public.is_admin()',
  null,
  ARRAY['email']::text[],
  false  -- disabled by default until PR 17 wires it; enable per-environment
)
ON CONFLICT (host_kind) DO NOTHING;

-- ==========================================================================
-- Notes on cutover (for future operators)
-- ==========================================================================
-- Application code path (workers/builder.ts, admin UI):
--   1. PR 16.a (this): schema link only. App code untouched.
--   2. PR 16.b: workers read templates_block_def_id when set; fall back
--      to legacy block_template_id otherwise.
--   3. PR 16.c: admin migrate-script copies legacy block_templates →
--      templates_block_defs and updates edition_blocks to point at the new
--      ids.
--   4. Final cutover: enforce NOT NULL on templates_block_def_id and drop
--      newsletters_block_templates / newsletters_brick_templates.
--
-- This staged path is overkill if newsletter has no production data; the
-- user has authorized "drop the old newsletter tables" — so PR 16.c can
-- collapse 2/3/4 into a single drop migration once UI is rewired.
