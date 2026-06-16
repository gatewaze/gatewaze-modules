-- ============================================================================
-- 026_apply_source_declarative_render_kind
-- ============================================================================
--
-- The block_defs rows produced by the declarative apply path
-- (blocks/<key>.html ingested from the source repo) were landing with NULL
-- render_kind and NULL component_id. The check constraint added in 022
-- (`templates_block_defs_render_kind_component_id`) tolerates the NULL pair,
-- so apply itself succeeded — but downstream:
--
--   * the admin client's "Update" button tried to PATCH render_kind to
--     'react-email' without a component_id, which DID violate the check
--     constraint, and the apply step appeared to fail end-to-end;
--   * the htmlOutputAdapter + renderViaEditionEmail routing treats only
--     render_kind='react-email' as the JSX path, so declarative blocks
--     fell through to the Mustache renderer and their JSX-syntax html
--     (`<Section>…`) was emitted into the final email verbatim.
--
-- Fix at the source: this redefines templates_apply_source so every block
-- def it writes carries render_kind='declarative' + component_id=key. The
-- check constraint is satisfied, the routing treats them as react-email-
-- equivalent (after the matching admin-side change), and the "Update" PATCH
-- becomes unnecessary.
--
-- Bricks: same treatment for symmetry. Bricks render via the same
-- declarative path as their parent block.
--
-- Backfill: existing rows with NULL render_kind (or render_kind set to
-- something other than the three constraint values) are coerced to
-- declarative + component_id=key. Idempotent.
--
-- This migration leaves the prune-absent logic from 024 unchanged — it
-- just rewrites the inserts/updates to populate the two new fields.
-- ============================================================================

-- Backfill existing rows that match the apply-output pattern (NULL
-- render_kind / NULL component_id, came from the declarative apply path).
-- Skip rows that are already correctly tagged.
UPDATE public.templates_block_defs
   SET render_kind = 'declarative', component_id = key
 WHERE render_kind IS NULL
   AND (component_id IS NULL OR component_id = '');

UPDATE public.templates_brick_defs
   SET render_kind = 'declarative', component_id = key
 WHERE render_kind IS NULL
   AND (component_id IS NULL OR component_id = '');

-- Re-create apply_source with the explicit render_kind / component_id
-- columns on both INSERT branches (block + brick) and on the UPDATE that
-- bumps existing rows when content changes. Otherwise identical to 024:
-- the prune-absent logic is preserved verbatim.
CREATE OR REPLACE FUNCTION public.templates_apply_source(
  p_source_id  uuid,
  p_source_sha text,
  p_wrappers   jsonb,
  p_block_defs jsonb,
  p_definitions jsonb,
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
  v_library_id      uuid;
  v_library_kind    text;
  v_block_def_id    uuid;
  v_existing_id     uuid;
  v_block_count     int := 0;
  v_brick_count     int := 0;
  v_wrapper_count   int := 0;
  v_pruned_count    int := 0;
  v_artifacts       jsonb := '[]'::jsonb;
  w_item            jsonb;
  b_item            jsonb;
  br_item           jsonb;
  v_present_keys    text[];
  v_pruned_block_id uuid;
BEGIN
  SELECT library_id INTO v_library_id
    FROM public.templates_sources
   WHERE id = p_source_id;
  IF v_library_id IS NULL THEN
    RAISE EXCEPTION 'source % not found', p_source_id;
  END IF;

  SELECT theme_kind INTO v_library_kind
    FROM public.templates_libraries WHERE id = v_library_id;

  -- Wrappers
  FOR w_item IN SELECT jsonb_array_elements(COALESCE(p_wrappers, '[]'::jsonb)) LOOP
    SELECT id INTO v_existing_id
      FROM public.templates_wrappers
     WHERE library_id = v_library_id AND key = (w_item->>'key') AND is_current = true;
    IF v_existing_id IS NULL THEN
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb), 1, true);
      END IF;
      v_wrapper_count := v_wrapper_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'wrapper', 'key', w_item->>'key', 'action', 'inserted'));
    ELSE
      IF NOT p_dry_run THEN
        UPDATE public.templates_wrappers SET is_current = false WHERE id = v_existing_id;
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, version, is_current)
        SELECT v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
               COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
               (SELECT COALESCE(MAX(version), 0) + 1 FROM public.templates_wrappers
                 WHERE library_id = v_library_id AND key = (w_item->>'key')),
               true;
      END IF;
      v_wrapper_count := v_wrapper_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'wrapper', 'key', w_item->>'key', 'action', 'updated'));
    END IF;
  END LOOP;

  -- Blocks (+ their bricks)
  v_present_keys := ARRAY[]::text[];
  FOR b_item IN SELECT jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) LOOP
    v_present_keys := array_append(v_present_keys, b_item->>'key');

    SELECT id INTO v_existing_id
      FROM public.templates_block_defs
     WHERE library_id = v_library_id AND key = (b_item->>'key') AND is_current = true;

    IF v_existing_id IS NULL THEN
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_block_defs
          (library_id, key, name, description, schema, html, has_bricks, theme_kind,
           render_kind, component_id)
        VALUES (v_library_id, b_item->>'key', b_item->>'name', b_item->>'description',
                COALESCE(b_item->'schema', '{}'::jsonb),
                COALESCE(b_item->>'html', ''),
                COALESCE((b_item->>'has_bricks')::boolean, false),
                v_library_kind,
                'declarative',
                b_item->>'key')
        RETURNING id INTO v_block_def_id;
      ELSE
        v_block_def_id := gen_random_uuid();
      END IF;
      v_block_count := v_block_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'block_def', 'key', b_item->>'key', 'action', 'inserted', 'id', v_block_def_id));
    ELSE
      v_block_def_id := v_existing_id;
      IF NOT p_dry_run THEN
        UPDATE public.templates_block_defs
           SET name         = b_item->>'name',
               description  = b_item->>'description',
               schema       = COALESCE(b_item->'schema', '{}'::jsonb),
               html         = COALESCE(b_item->>'html', ''),
               has_bricks   = COALESCE((b_item->>'has_bricks')::boolean, false),
               render_kind  = 'declarative',
               component_id = b_item->>'key',
               updated_at   = now()
         WHERE id = v_block_def_id;
      END IF;
      v_block_count := v_block_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'block_def', 'key', b_item->>'key', 'action', 'updated', 'id', v_block_def_id));
    END IF;

    -- Bricks of this block
    FOR br_item IN SELECT jsonb_array_elements(COALESCE(b_item->'bricks', '[]'::jsonb)) LOOP
      SELECT id INTO v_existing_id
        FROM public.templates_brick_defs
       WHERE block_def_id = v_block_def_id AND key = (br_item->>'key') AND is_current = true;
      IF v_existing_id IS NULL THEN
        IF NOT p_dry_run THEN
          INSERT INTO public.templates_brick_defs
            (block_def_id, key, name, schema, html, sort_order, render_kind, component_id)
          VALUES (v_block_def_id, br_item->>'key', br_item->>'name',
                  COALESCE(br_item->'schema', '{}'::jsonb), br_item->>'html',
                  COALESCE((br_item->>'sort_order')::int, 0),
                  'declarative',
                  br_item->>'key');
        END IF;
        v_brick_count := v_brick_count + 1;
        v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'brick_def', 'key', br_item->>'key', 'action', 'inserted'));
      ELSE
        IF NOT p_dry_run THEN
          UPDATE public.templates_brick_defs
             SET name         = br_item->>'name',
                 schema       = COALESCE(br_item->'schema', '{}'::jsonb),
                 html         = br_item->>'html',
                 sort_order   = COALESCE((br_item->>'sort_order')::int, 0),
                 render_kind  = 'declarative',
                 component_id = br_item->>'key',
                 updated_at   = now()
           WHERE id = v_existing_id;
        END IF;
        v_brick_count := v_brick_count + 1;
        v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'brick_def', 'key', br_item->>'key', 'action', 'updated'));
      END IF;
    END LOOP;
  END LOOP;

  -- Prune blocks whose keys disappeared from the source (soft-deactivate; see
  -- migration 024 for the rationale).
  IF NOT p_dry_run THEN
    FOR v_pruned_block_id IN
      SELECT d.id
        FROM public.templates_block_defs d
       WHERE d.library_id = v_library_id
         AND d.is_current = true
         AND NOT (d.key = ANY(v_present_keys))
    LOOP
      UPDATE public.templates_brick_defs br
         SET is_current = false, updated_at = now()
       WHERE br.block_def_id = v_pruned_block_id
         AND br.is_current = true;
      UPDATE public.templates_block_defs
         SET is_current = false, updated_at = now()
       WHERE id = v_pruned_block_id;
      v_pruned_count := v_pruned_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'block_def', 'action', 'pruned', 'id', v_pruned_block_id));
    END LOOP;
  ELSE
    SELECT count(*) INTO v_pruned_count
      FROM public.templates_block_defs d
     WHERE d.library_id = v_library_id
       AND d.is_current = true
       AND NOT (d.key = ANY(v_present_keys));
  END IF;

  RETURN jsonb_build_object(
    'artifacts',      v_artifacts,
    'wrappers',       v_wrapper_count,
    'block_defs',     v_block_count,
    'brick_defs',     v_brick_count,
    'pruned_blocks',  v_pruned_count
  );
END;
$body$;

COMMENT ON FUNCTION public.templates_apply_source(uuid, text, jsonb, jsonb, jsonb, boolean)
  IS 'Persist a templates parse result for one source. Declarative-output: every block_def + brick_def lands with render_kind=''declarative'' + component_id=key so the routing in EditionEmail dispatches them through the declarative renderer. Per spec-templates-module §6 + migration 022 check constraint.';
