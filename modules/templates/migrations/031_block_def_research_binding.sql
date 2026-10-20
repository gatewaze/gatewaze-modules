-- ============================================================================
-- 031_block_def_research_binding
-- ============================================================================
--
-- A block may declare a research binding (spec-content-discovery-and-
-- research-blocks.md §5.1) in its DATA_SOURCE marker:
--   <!-- DATA_SOURCE: { "kind": "research", "input": {...}, "transform": {...},
--                       "output": {"field": "items"}, "schedule": "edition" } -->
-- The TypeScript parser has carried DATA_SOURCE to this RPC since 0xx, but
-- the INSERT and UPDATE here never wrote it, so it was parsed and dropped.
--
-- This migration:
--   1. extends the source_kind CHECK with 'research';
--   2. re-creates templates_apply_source so block defs persist data_source,
--      source_kind ('research' when the marker says so, else 'static') and
--      block_kind ('ai-generated' when a recipe is involved, else
--      'gatewaze-internal'; 'static' otherwise) with freshness 'build-time'
--      (the 014 trigger requires it for gatewaze-internal), so the palette's
--      existing labelling stays truthful.
-- Everything else in the function is byte-for-byte migration 026.
-- Idempotent.
-- ============================================================================

ALTER TABLE public.templates_block_defs DROP CONSTRAINT IF EXISTS templates_block_defs_source_kind_check;
ALTER TABLE public.templates_block_defs ADD CONSTRAINT templates_block_defs_source_kind_check
  CHECK (source_kind IN ('static','external-api','internal-content','research'));

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

    -- A research binding is validated by the TypeScript ingest; re-check the
    -- parts that matter to the worker here too, so a caller that bypasses the
    -- parser cannot persist a binding the worker would act on blindly.
    IF b_item->'data_source'->>'kind' = 'research' THEN
      IF NOT (b_item->'data_source'->'input'->>'kind' IN ('discovery_posts','recipe')) THEN
        RAISE EXCEPTION 'block % research binding: input.kind must be discovery_posts or recipe', b_item->>'key';
      END IF;
      IF NOT (COALESCE(b_item->'data_source'->'output'->>'field','') ~ '^[a-z][a-z0-9_]{0,63}$')
         OR b_item->'data_source'->'output'->>'field' IN ('research_edits','children') THEN
        RAISE EXCEPTION 'block % research binding: output.field is missing, invalid or reserved', b_item->>'key';
      END IF;
      IF (b_item->'data_source'->'input'->>'kind' = 'recipe' AND NOT (COALESCE(b_item->'data_source'->'input'->>'use_case','') ~ '^newsletter-[a-z0-9_-]{1,90}$'))
         OR (b_item->'data_source'->'transform'->>'kind' = 'recipe' AND NOT (COALESCE(b_item->'data_source'->'transform'->>'use_case','') ~ '^newsletter-[a-z0-9_-]{1,90}$')) THEN
        RAISE EXCEPTION 'block % research binding: recipe use cases must be newsletter-* ids', b_item->>'key';
      END IF;
    END IF;

    SELECT id INTO v_existing_id
      FROM public.templates_block_defs
     WHERE library_id = v_library_id AND key = (b_item->>'key') AND is_current = true;

    IF v_existing_id IS NULL THEN
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_block_defs
          (library_id, key, name, description, schema, html, has_bricks, theme_kind,
           render_kind, component_id, data_source, source_kind, block_kind, freshness)
        VALUES (v_library_id, b_item->>'key', b_item->>'name', b_item->>'description',
                COALESCE(b_item->'schema', '{}'::jsonb),
                COALESCE(b_item->>'html', ''),
                COALESCE((b_item->>'has_bricks')::boolean, false),
                v_library_kind,
                'declarative',
                b_item->>'key',
                NULLIF(b_item->'data_source', 'null'::jsonb),
                CASE WHEN b_item->'data_source'->>'kind' = 'research' THEN 'research' ELSE 'static' END,
                CASE WHEN b_item->'data_source'->>'kind' = 'research'
                     THEN CASE WHEN (b_item->'data_source'->'input'->>'kind') = 'recipe'
                                 OR (b_item->'data_source'->'transform'->>'kind') = 'recipe'
                               THEN 'ai-generated' ELSE 'gatewaze-internal' END
                     ELSE 'static' END,
                -- research output is produced ahead of render, never at send time
                CASE WHEN b_item->'data_source'->>'kind' = 'research' THEN 'build-time' ELSE NULL END)
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
               data_source  = NULLIF(b_item->'data_source', 'null'::jsonb),
               -- Only research bindings change the kind columns; a def that stops
               -- being research goes back to static; anything else keeps what the
               -- operator or another path set (so an existing gatewaze-internal def
               -- with a freshness is not reset and tripped by the 014 trigger).
               source_kind  = CASE WHEN b_item->'data_source'->>'kind' = 'research' THEN 'research'
                                   WHEN source_kind = 'research' THEN 'static' ELSE source_kind END,
               block_kind   = CASE WHEN b_item->'data_source'->>'kind' = 'research'
                                   THEN CASE WHEN (b_item->'data_source'->'input'->>'kind') = 'recipe'
                                               OR (b_item->'data_source'->'transform'->>'kind') = 'recipe'
                                             THEN 'ai-generated' ELSE 'gatewaze-internal' END
                                   WHEN source_kind = 'research' THEN 'static' ELSE block_kind END,
               freshness    = CASE WHEN b_item->'data_source'->>'kind' = 'research' THEN 'build-time'
                                   WHEN source_kind = 'research' THEN NULL ELSE freshness END,
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

-- The apply RPC is SECURITY DEFINER and writes block HTML and bindings; only
-- the api process (service role) runs the ingest. The default ACL on a newly
-- created function includes PUBLIC, so say so explicitly.
REVOKE ALL ON FUNCTION public.templates_apply_source(uuid, text, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.templates_apply_source(uuid, text, jsonb, jsonb, jsonb, boolean) TO service_role, authenticated;
