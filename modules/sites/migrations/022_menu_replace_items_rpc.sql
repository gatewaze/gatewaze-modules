-- ============================================================================
-- Migration: sites_022_menu_replace_items_rpc
-- Description: RPC for atomic bulk-replace of menu items.
--              Per spec §22.5 + lib/api/menus-routes.ts.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.navigation_menu_replace_items(
  p_menu_id uuid,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_id uuid;
  v_id_map jsonb := '{}'::jsonb;
  v_pass int;
BEGIN
  -- Step 1: delete all existing items for this menu (cascades children).
  DELETE FROM public.navigation_menu_items WHERE menu_id = p_menu_id;

  -- Step 2: two-pass insert. First insert all top-level (parent_id NULL),
  -- collecting their generated ids by their array index. Then insert
  -- children, mapping their declared parent_index to the generated id.
  --
  -- The input `p_items` is an array where each item has its position
  -- (`order_index`), an optional `parent_index` (or `parent_id` if pre-existing),
  -- and the standard menu-item fields.
  FOR v_pass IN 1..5 LOOP
    -- Anti-cycle guard: max nesting depth 5
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      -- Skip items already inserted (id assigned in v_id_map keyed by index)
      IF v_id_map ? (v_item->>'index') THEN
        CONTINUE;
      END IF;
      -- Resolve parent_id from id_map if parent_index provided
      v_id := NULL;
      IF v_item ? 'parent_index' AND v_id_map ? (v_item->>'parent_index') THEN
        v_id := (v_id_map->>(v_item->>'parent_index'))::uuid;
      ELSIF v_item ? 'parent_id' AND (v_item->>'parent_id') IS NOT NULL THEN
        v_id := (v_item->>'parent_id')::uuid;
      END IF;

      -- Skip children whose parent isn't yet inserted
      IF v_item ? 'parent_index' AND NOT (v_id_map ? (v_item->>'parent_index')) THEN
        CONTINUE;
      END IF;

      INSERT INTO public.navigation_menu_items (
        menu_id, parent_id, order_index, label,
        page_id, external_url, anchor_target,
        open_in_new_tab, rel_attributes, css_classes, visibility
      ) VALUES (
        p_menu_id, v_id, COALESCE((v_item->>'order_index')::int, 0), v_item->>'label',
        NULLIF(v_item->>'page_id', '')::uuid, v_item->>'external_url', v_item->>'anchor_target',
        COALESCE((v_item->>'open_in_new_tab')::boolean, false),
        CASE WHEN v_item ? 'rel_attributes' THEN ARRAY(SELECT jsonb_array_elements_text(v_item->'rel_attributes')) ELSE NULL END,
        v_item->>'css_classes', COALESCE(v_item->>'visibility', 'always')
      ) RETURNING id INTO v_id;

      v_id_map := v_id_map || jsonb_build_object(v_item->>'index', v_id);
    END LOOP;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.navigation_menu_replace_items(uuid, jsonb) IS
  'Atomic bulk-replace of menu items for a menu. Two-pass insert (capped at depth 5) to handle parent_index → parent_id resolution from the input array.';

-- ============================================================================
-- RPC for swapping a block_def_id across all page_blocks of a site
-- (used by apply-theme/resolve when admin picks "replace_block")
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sites_swap_block_def(
  p_site_id uuid,
  p_old_block_name text,
  p_new_block_name text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_id uuid;
  v_new_id uuid;
  v_count int;
BEGIN
  SELECT id INTO v_old_id FROM public.templates_block_defs
    WHERE name = p_old_block_name LIMIT 1;
  SELECT id INTO v_new_id FROM public.templates_block_defs
    WHERE name = p_new_block_name LIMIT 1;
  IF v_old_id IS NULL OR v_new_id IS NULL THEN
    RAISE EXCEPTION 'block def lookup failed: old=%, new=%', p_old_block_name, p_new_block_name;
  END IF;
  WITH affected AS (
    UPDATE public.page_blocks SET block_def_id = v_new_id
    WHERE block_def_id = v_old_id
      AND page_id IN (SELECT id FROM public.pages WHERE host_kind = 'site' AND host_id = p_site_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM affected;
  RETURN v_count;
END $$;

-- ============================================================================
-- RPC for renaming fields across all page_blocks.content of a block-def name
-- (used by apply-theme/resolve when admin picks "bulk_update_pages")
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sites_rename_block_fields(
  p_site_id uuid,
  p_block_name text,
  p_field_map jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_block_def_id uuid;
  v_count int := 0;
  v_old_key text;
  v_new_key text;
  v_pair record;
BEGIN
  SELECT id INTO v_block_def_id FROM public.templates_block_defs
    WHERE name = p_block_name LIMIT 1;
  IF v_block_def_id IS NULL THEN
    RAISE EXCEPTION 'block def not found: %', p_block_name;
  END IF;

  -- For each {old: new} pair, rewrite the JSONB content.
  FOR v_pair IN SELECT * FROM jsonb_each_text(p_field_map) LOOP
    v_old_key := v_pair.key;
    v_new_key := v_pair.value;
    UPDATE public.page_blocks
    SET content = (content - v_old_key) || jsonb_build_object(v_new_key, content->v_old_key)
    WHERE block_def_id = v_block_def_id
      AND page_id IN (SELECT id FROM public.pages WHERE host_kind = 'site' AND host_id = p_site_id)
      AND content ? v_old_key;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END LOOP;

  RETURN v_count;
END $$;
