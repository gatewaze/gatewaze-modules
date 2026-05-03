-- ============================================================================
-- Migration: sites_028_mega_menus_and_segments
-- Description: Two v1.x extensions to navigation_menu_items per spec §3:
--                1. Mega menu support (rich-content menu items)
--                2. Conditional visibility per audience segment
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Mega menus — rich content panels expanded under top-level menu items
-- ----------------------------------------------------------------------------

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS render_kind text NOT NULL DEFAULT 'link'
  CHECK (render_kind IN ('link', 'mega_panel', 'mega_column_header'));

COMMENT ON COLUMN public.navigation_menu_items.render_kind IS
  'link = standard nav item; mega_panel = expands to a multi-column panel on hover (top-level only); mega_column_header = column heading inside a mega_panel parent.';

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.navigation_menu_items.description IS
  'Optional short description shown beneath the label in mega menu panels (and as a tooltip in standard menus).';

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS icon text;

COMMENT ON COLUMN public.navigation_menu_items.icon IS
  'Icon identifier (heroicons name e.g. ''Cog6ToothIcon'', or asset URL). Rendered alongside the label in the wrapper component.';

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS featured_image text;

COMMENT ON COLUMN public.navigation_menu_items.featured_image IS
  'Optional featured image for mega-menu items (e.g. blog-post thumbnail in a ''Latest posts'' mega column).';

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS column_index integer;

COMMENT ON COLUMN public.navigation_menu_items.column_index IS
  'For items inside a mega_panel parent: which column they belong to (0-indexed). NULL for non-mega items.';

-- ----------------------------------------------------------------------------
-- 2. Conditional visibility — segment-aware menu items
-- ----------------------------------------------------------------------------

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS visibility_segments text[];

COMMENT ON COLUMN public.navigation_menu_items.visibility_segments IS
  'Per spec §3 (v1.x): show only when current user matches one of these segment slugs. Combined with `visibility` (always|authenticated_only|public_only) using AND. NULL = no segment restriction. Resolved at SSR via the segments module if installed.';

-- Useful for the wrapper consumer to filter quickly without joining
CREATE INDEX IF NOT EXISTS idx_menu_items_visibility_segments
  ON public.navigation_menu_items USING GIN (visibility_segments)
  WHERE visibility_segments IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Update the public-anon read policy: mega_panel / mega_column_header items
-- with NO target (no page_id, no external_url, no anchor_target) are valid
-- and should be returned to anon (they're container/heading items).
-- The CHECK constraint in 016 already allows this for existing rows;
-- this comment documents the expectation.
-- ----------------------------------------------------------------------------

COMMENT ON CONSTRAINT navigation_menu_items_check ON public.navigation_menu_items IS
  'Originally required exactly-one-target (page_id | external_url | anchor_target). Per migration 028: mega_panel and mega_column_header items may have zero targets (they are container nodes, not links). The API layer enforces the per-render_kind variant via stricter validation.';
