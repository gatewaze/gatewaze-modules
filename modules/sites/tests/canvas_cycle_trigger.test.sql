-- pgTAP: trg_page_blocks_no_cycle (canvas tables, migration 032).
-- Per spec-sites-wysiwyg-builder §4.3 — the trigger MUST refuse a
-- parent_brick_id that would create a cycle in the (block → brick →
-- block) descent path. The PL/pgSQL implementation walks up the chain
-- with a depth bound; we exercise:
--   1. happy-path 2-level nest insert (allowed)
--   2. self-referencing parent_brick (rejected)
--   3. transitive cycle: A's brick contains B, then point A's
--      parent_brick at B's brick (rejected)
--   4. depth-32 cap

BEGIN;

SELECT plan(6);

-- ==========================================================================
-- Setup: minimal site + page + library + block_def + brick_def. Service
-- role: bypass RLS. We use deterministic UUIDs so error messages are
-- legible.
-- ==========================================================================

-- Library + block_def + brick_def used by every block in this test.
INSERT INTO public.templates_libraries (id, key, name)
VALUES ('00000000-aaaa-1111-0000-000000000001', 'cycle-test-lib', 'cycle test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.templates_block_defs (id, library_id, key, html, schema, has_bricks, is_current)
VALUES
  ('00000000-bbbb-1111-0000-000000000002', '00000000-aaaa-1111-0000-000000000001', 'col2', '<div data-block-root>{{>l}}{{>r}}</div>', '{}'::jsonb, true,  true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.templates_brick_defs (id, block_def_id, key, html, schema)
VALUES
  ('00000000-cccc-1111-0000-000000000003', '00000000-bbbb-1111-0000-000000000002', 'l', '<div class="col">{{>children}}</div>', '{}'::jsonb),
  ('00000000-cccc-1111-0000-000000000004', '00000000-bbbb-1111-0000-000000000002', 'r', '<div class="col">{{>children}}</div>', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sites (id, slug, host_kind, theme_kind, templates_library_id)
VALUES ('00000000-dddd-1111-0000-000000000005', 'cycle-site', 'site', 'website', '00000000-aaaa-1111-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pages (id, host_kind, host_id, slug, full_path, title, status, composition_mode)
VALUES ('00000000-eeee-1111-0000-000000000006', 'site', '00000000-dddd-1111-0000-000000000005', 'home', '/', 'home', 'draft', 'blocks')
ON CONFLICT (id) DO NOTHING;

-- Block A (top-level) + its left brick.
INSERT INTO public.page_blocks (id, page_id, block_def_id, parent_brick_id, sort_order, content)
VALUES ('aaaaaaaa-0001-1111-0000-000000000001',
        '00000000-eeee-1111-0000-000000000006',
        '00000000-bbbb-1111-0000-000000000002',
        NULL, 1000, '{}'::jsonb);
INSERT INTO public.page_block_bricks (id, page_block_id, brick_def_id, sort_order, content)
VALUES ('aaaaaaaa-0001-bbbb-0000-000000000001',
        'aaaaaaaa-0001-1111-0000-000000000001',
        '00000000-cccc-1111-0000-000000000003',
        1000, '{}'::jsonb);

-- ==========================================================================
-- Test 1: nested block inside A's brick is allowed (legitimate 2-level nest).
-- ==========================================================================

SELECT lives_ok(
  $$INSERT INTO public.page_blocks (id, page_id, block_def_id, parent_brick_id, sort_order, content)
    VALUES ('bbbbbbbb-0001-1111-0000-000000000001',
            '00000000-eeee-1111-0000-000000000006',
            '00000000-bbbb-1111-0000-000000000002',
            'aaaaaaaa-0001-bbbb-0000-000000000001', 1000, '{}'::jsonb)$$,
  'nested block (B inside A.left) is allowed — depth 2'
);

-- B has its own left brick:
INSERT INTO public.page_block_bricks (id, page_block_id, brick_def_id, sort_order, content)
VALUES ('bbbbbbbb-0001-bbbb-0000-000000000001',
        'bbbbbbbb-0001-1111-0000-000000000001',
        '00000000-cccc-1111-0000-000000000003',
        1000, '{}'::jsonb);

-- ==========================================================================
-- Test 2: cycle: try to point A's parent_brick at B's brick. A is now
-- transitively reachable from itself: A.left → B → B.left → A. Trigger
-- must reject.
-- ==========================================================================

SELECT throws_like(
  $$UPDATE public.page_blocks
       SET parent_brick_id = 'bbbbbbbb-0001-bbbb-0000-000000000001'
     WHERE id = 'aaaaaaaa-0001-1111-0000-000000000001'$$,
  '%page_blocks_cycle%',
  'transitive cycle (A.parent → B.brick → B → A) is rejected'
);

-- ==========================================================================
-- Test 3: a block CANNOT have its own descendant brick as parent in one
-- step either — point B at its own brick.
-- ==========================================================================

SELECT throws_like(
  $$UPDATE public.page_blocks
       SET parent_brick_id = 'bbbbbbbb-0001-bbbb-0000-000000000001'
     WHERE id = 'bbbbbbbb-0001-1111-0000-000000000001'$$,
  '%page_blocks_cycle%',
  'self-cycle (B.parent → B.brick → B) is rejected'
);

-- ==========================================================================
-- Test 4: depth bound. We construct a chain of 33 blocks/bricks and
-- expect the 33rd insert to be rejected for exceeding depth 32. Note:
-- the trigger checks depth on the block being inserted; the chain must
-- be 33 deep to trip the bound.
-- ==========================================================================

DO $$
DECLARE
  i           int;
  prev_brick  uuid := 'aaaaaaaa-0001-bbbb-0000-000000000001';
  new_block   uuid;
  new_brick   uuid;
BEGIN
  FOR i IN 1..32 LOOP
    new_block := gen_random_uuid();
    new_brick := gen_random_uuid();
    INSERT INTO public.page_blocks (id, page_id, block_def_id, parent_brick_id, sort_order, content)
    VALUES (new_block, '00000000-eeee-1111-0000-000000000006',
            '00000000-bbbb-1111-0000-000000000002', prev_brick, 1000, '{}'::jsonb);
    INSERT INTO public.page_block_bricks (id, page_block_id, brick_def_id, sort_order, content)
    VALUES (new_brick, new_block,
            '00000000-cccc-1111-0000-000000000003', 1000, '{}'::jsonb);
    prev_brick := new_brick;
  END LOOP;
  -- Stash the deepest brick into a temp setting for the next assertion.
  PERFORM set_config('cycle_test.deepest_brick', prev_brick::text, false);
END $$;

SELECT throws_like(
  format(
    $$INSERT INTO public.page_blocks (id, page_id, block_def_id, parent_brick_id, sort_order, content)
      VALUES (gen_random_uuid(),
              '00000000-eeee-1111-0000-000000000006',
              '00000000-bbbb-1111-0000-000000000002',
              %L::uuid, 1000, '{}'::jsonb)$$,
    current_setting('cycle_test.deepest_brick')
  ),
  '%page_blocks_too_deep%',
  'depth >32 nested blocks is rejected by the trigger depth bound'
);

-- ==========================================================================
-- Test 5: trigger does NOT fire when parent_brick_id is unchanged. We
-- update content on the deepest existing block; should succeed.
-- ==========================================================================

SELECT lives_ok(
  $$UPDATE public.page_blocks SET content = '{"keep":"alive"}'::jsonb
     WHERE id = 'aaaaaaaa-0001-1111-0000-000000000001'$$,
  'content-only update does not trip the cycle trigger'
);

-- ==========================================================================
-- Test 6: NULL parent_brick_id (top-level block) is always permitted.
-- ==========================================================================

SELECT lives_ok(
  $$INSERT INTO public.page_blocks (id, page_id, block_def_id, parent_brick_id, sort_order, content)
    VALUES (gen_random_uuid(),
            '00000000-eeee-1111-0000-000000000006',
            '00000000-bbbb-1111-0000-000000000002',
            NULL, 9000, '{}'::jsonb)$$,
  'top-level block (parent_brick_id=NULL) inserts cleanly'
);

SELECT * FROM finish();
ROLLBACK;
