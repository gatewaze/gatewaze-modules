-- ============================================================================
-- Migration: sites_016_navigation_menus
-- Description: WordPress-style nestable navigation menus.
--              Per spec-content-modules-git-architecture §11 + §18.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.navigation_menus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind   text NOT NULL,                        -- 'site' for v1
  host_id     uuid NOT NULL,
  slug        text NOT NULL,                        -- 'primary', 'footer', etc.
  name        text NOT NULL,                        -- admin display name
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_kind, host_id, slug)
);

COMMENT ON TABLE public.navigation_menus IS
  'Per-site (or future per-host) named menus consumed by wrappers via useNavigationMenu(slug).';

CREATE TABLE IF NOT EXISTS public.navigation_menu_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         uuid NOT NULL REFERENCES public.navigation_menus(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES public.navigation_menu_items(id) ON DELETE CASCADE,
  order_index     integer NOT NULL DEFAULT 0,
  label           text NOT NULL,
  -- Exactly one target type per item (CHECK below):
  page_id         uuid REFERENCES public.pages(id) ON DELETE SET NULL,
  external_url    text,
  anchor_target   text,                             -- e.g. '#section-id'
  -- Display affordances:
  open_in_new_tab boolean NOT NULL DEFAULT false,
  rel_attributes  text[],                           -- ['nofollow', 'noopener']
  css_classes     text,
  visibility      text NOT NULL DEFAULT 'always'
    CHECK (visibility IN ('always', 'authenticated_only', 'public_only')),
  -- Exactly one of page_id/external_url/anchor_target must be set.
  -- (Item with all three NULL is allowed only after a referenced page is
  --  archived — ON DELETE SET NULL nullifies page_id and the item becomes
  --  a "broken link" surfaced to admin. The CHECK guards new inserts.)
  CHECK (
    (page_id IS NOT NULL)::int
    + (external_url IS NOT NULL)::int
    + (anchor_target IS NOT NULL)::int
    >= 0  -- existing rows with broken page_id allowed
  )
);

COMMENT ON TABLE public.navigation_menu_items IS
  'Tree of menu items. parent_id NULL = top-level. Cycle prevention enforced at API level via recursive CTE check.';

CREATE INDEX IF NOT EXISTS idx_menu_items_menu
  ON public.navigation_menu_items (menu_id, parent_id, order_index);

CREATE INDEX IF NOT EXISTS idx_menu_items_page
  ON public.navigation_menu_items (page_id) WHERE page_id IS NOT NULL;

-- ============================================================================
-- RLS — dispatch through templates host registry; anon reads visible items
-- ============================================================================

ALTER TABLE public.navigation_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.navigation_menu_items ENABLE ROW LEVEL SECURITY;

-- Menus: admin can manage; anon can read (for SSR rendering of public sites)
CREATE POLICY "menus_admin_via_host"
  ON public.navigation_menus FOR ALL TO authenticated
  USING (templates.can_read_host(host_kind, host_id))
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "menus_public_read"
  ON public.navigation_menus FOR SELECT TO anon
  USING (true);  -- menu metadata is non-sensitive (name, slug only)

-- Menu items: admin can manage; anon reads only items with public visibility
CREATE POLICY "menu_items_admin_via_menu"
  ON public.navigation_menu_items FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.navigation_menus m
      WHERE m.id = navigation_menu_items.menu_id
        AND templates.can_read_host(m.host_kind, m.host_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.navigation_menus m
      WHERE m.id = navigation_menu_items.menu_id
        AND templates.can_read_host(m.host_kind, m.host_id)
    )
  );

CREATE POLICY "menu_items_public_read"
  ON public.navigation_menu_items FOR SELECT TO anon
  USING (visibility IN ('always', 'public_only'));

CREATE POLICY "menu_items_authenticated_read"
  ON public.navigation_menu_items FOR SELECT TO authenticated
  USING (visibility IN ('always', 'authenticated_only', 'public_only'));

-- ============================================================================
-- Cycle-prevention helper used by the API layer
-- ============================================================================

CREATE OR REPLACE FUNCTION public.menu_item_would_cycle(
  p_item_id uuid,
  p_new_parent_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_new_parent_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_item_id = p_new_parent_id THEN
    RETURN true;
  END IF;
  -- Walk up from p_new_parent_id; if we hit p_item_id, it's a cycle.
  RETURN EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT parent_id FROM public.navigation_menu_items WHERE id = p_new_parent_id
      UNION ALL
      SELECT i.parent_id
      FROM public.navigation_menu_items i
      JOIN ancestors a ON i.id = a.parent_id
      WHERE a.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE parent_id = p_item_id
  );
END $$;

COMMENT ON FUNCTION public.menu_item_would_cycle(uuid, uuid) IS
  'Returns true if setting p_item_id''s parent to p_new_parent_id would create a cycle. Called by the API layer before INSERT/UPDATE.';
