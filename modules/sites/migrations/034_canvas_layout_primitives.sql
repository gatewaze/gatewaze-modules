-- ============================================================================
-- Migration: sites_034_canvas_layout_primitives
-- Description: Seed the layout primitive block_defs that ship with the
--              default theme. Per spec-sites-wysiwyg-builder §4.4.
--
--   - section          (1 brick: inner)         — full-width container
--   - row-2col         (2 bricks: left, right)  — 50/50 split
--   - row-3col         (3 bricks: l/m/r)        — thirds
--   - row-4col         (4 bricks: c1..c4)       — quarters
--   - spacer           (no bricks)              — adjustable height
--
-- Idempotency via WHERE NOT EXISTS — simpler than ON CONFLICT and works
-- regardless of whether a (library_id, key) unique index exists on
-- templates_block_defs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.canvas_seed_layout_primitives(p_library_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_section_id uuid;
  v_row2_id    uuid;
  v_row3_id    uuid;
  v_row4_id    uuid;
BEGIN
  -- 1. section
  SELECT id INTO v_section_id FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = 'section' AND is_current = true;
  IF v_section_id IS NULL THEN
    INSERT INTO public.templates_block_defs
      (library_id, key, name, description, source_kind, schema, html, has_bricks,
       version, is_current, canvas_validated, theme_kind)
    VALUES (
      p_library_id, 'section', 'Section', 'Full-width container with background and padding.',
      'static',
      '{"type":"object","properties":{"bgColor":{"type":"string","title":"Background colour"},"paddingY":{"type":"string","enum":["sm","md","lg","xl"],"default":"md","title":"Vertical padding"}}}'::jsonb,
      '<section data-block-root class="gw-section gw-pad-{{paddingY}}" style="background-color: {{bgColor}}"><div data-children="inner" class="gw-section-inner">{{>inner}}</div></section>',
      true, 1, true, true, 'website'
    )
    RETURNING id INTO v_section_id;
    INSERT INTO public.templates_brick_defs (block_def_id, key, name, schema, html, sort_order)
    VALUES (v_section_id, 'inner', 'Inner', '{"type":"object"}'::jsonb,
            '<div class="gw-col">{{>children}}</div>', 0);
  END IF;

  -- 2. row-2col
  SELECT id INTO v_row2_id FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = 'row-2col' AND is_current = true;
  IF v_row2_id IS NULL THEN
    INSERT INTO public.templates_block_defs
      (library_id, key, name, description, source_kind, schema, html, has_bricks,
       version, is_current, canvas_validated, theme_kind)
    VALUES (
      p_library_id, 'row-2col', 'Two columns', 'Two equal-width columns side by side.',
      'static',
      '{"type":"object","properties":{"gap":{"type":"string","enum":["none","sm","md","lg"],"default":"md","title":"Gap"}}}'::jsonb,
      '<div data-block-root class="gw-row gw-row-2col gw-gap-{{gap}}"><div data-children="left" class="gw-col">{{>left}}</div><div data-children="right" class="gw-col">{{>right}}</div></div>',
      true, 1, true, true, 'website'
    )
    RETURNING id INTO v_row2_id;
    INSERT INTO public.templates_brick_defs (block_def_id, key, name, schema, html, sort_order) VALUES
      (v_row2_id, 'left',  'Left',  '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 0),
      (v_row2_id, 'right', 'Right', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 1);
  END IF;

  -- 3. row-3col
  SELECT id INTO v_row3_id FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = 'row-3col' AND is_current = true;
  IF v_row3_id IS NULL THEN
    INSERT INTO public.templates_block_defs
      (library_id, key, name, description, source_kind, schema, html, has_bricks,
       version, is_current, canvas_validated, theme_kind)
    VALUES (
      p_library_id, 'row-3col', 'Three columns', 'Three equal-width columns.',
      'static',
      '{"type":"object","properties":{"gap":{"type":"string","enum":["none","sm","md","lg"],"default":"md","title":"Gap"}}}'::jsonb,
      '<div data-block-root class="gw-row gw-row-3col gw-gap-{{gap}}"><div data-children="left" class="gw-col">{{>left}}</div><div data-children="middle" class="gw-col">{{>middle}}</div><div data-children="right" class="gw-col">{{>right}}</div></div>',
      true, 1, true, true, 'website'
    )
    RETURNING id INTO v_row3_id;
    INSERT INTO public.templates_brick_defs (block_def_id, key, name, schema, html, sort_order) VALUES
      (v_row3_id, 'left',   'Left',   '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 0),
      (v_row3_id, 'middle', 'Middle', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 1),
      (v_row3_id, 'right',  'Right',  '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 2);
  END IF;

  -- 4. row-4col
  SELECT id INTO v_row4_id FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = 'row-4col' AND is_current = true;
  IF v_row4_id IS NULL THEN
    INSERT INTO public.templates_block_defs
      (library_id, key, name, description, source_kind, schema, html, has_bricks,
       version, is_current, canvas_validated, theme_kind)
    VALUES (
      p_library_id, 'row-4col', 'Four columns', 'Four equal-width columns.',
      'static',
      '{"type":"object","properties":{"gap":{"type":"string","enum":["none","sm","md","lg"],"default":"md","title":"Gap"}}}'::jsonb,
      '<div data-block-root class="gw-row gw-row-4col gw-gap-{{gap}}"><div data-children="c1" class="gw-col">{{>c1}}</div><div data-children="c2" class="gw-col">{{>c2}}</div><div data-children="c3" class="gw-col">{{>c3}}</div><div data-children="c4" class="gw-col">{{>c4}}</div></div>',
      true, 1, true, true, 'website'
    )
    RETURNING id INTO v_row4_id;
    INSERT INTO public.templates_brick_defs (block_def_id, key, name, schema, html, sort_order) VALUES
      (v_row4_id, 'c1', 'Column 1', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 0),
      (v_row4_id, 'c2', 'Column 2', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 1),
      (v_row4_id, 'c3', 'Column 3', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 2),
      (v_row4_id, 'c4', 'Column 4', '{"type":"object"}'::jsonb, '<div class="gw-col">{{>children}}</div>', 3);
  END IF;

  -- 5. spacer (no bricks)
  IF NOT EXISTS (SELECT 1 FROM public.templates_block_defs
                  WHERE library_id = p_library_id AND key = 'spacer' AND is_current = true) THEN
    INSERT INTO public.templates_block_defs
      (library_id, key, name, description, source_kind, schema, html, has_bricks,
       version, is_current, canvas_validated, theme_kind)
    VALUES (
      p_library_id, 'spacer', 'Spacer', 'Adjustable vertical whitespace.',
      'static',
      '{"type":"object","properties":{"height":{"type":"string","enum":["xs","sm","md","lg","xl"],"default":"md","title":"Height"}}}'::jsonb,
      '<div data-block-root class="gw-spacer gw-spacer-{{height}}" aria-hidden="true"></div>',
      false, 1, true, true, 'website'
    );
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_seed_layout_primitives(uuid) TO service_role;

-- Apply to every existing website-kind library.
DO $$
DECLARE
  v_lib_id uuid;
BEGIN
  FOR v_lib_id IN SELECT id FROM public.templates_libraries WHERE theme_kind = 'website' LOOP
    PERFORM public.canvas_seed_layout_primitives(v_lib_id);
  END LOOP;
END $$;
