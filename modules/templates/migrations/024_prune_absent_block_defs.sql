-- 024_prune_absent_block_defs
--
-- A git/HTML sync was additive-only: templates_apply_source inserted or updated
-- the blocks present in the parse but NEVER removed blocks that had disappeared
-- from the source. So a library's palette only ever grew, drifting away from the
-- repo's actual content (e.g. an old import's Header/Footer/AI Summary blocks
-- lingering after the repo dropped them).
--
-- This redefines templates_apply_source to PRUNE: after applying the parse, any
-- currently-active block in the library whose key is absent from the parse is
-- soft-deactivated (is_current=false), along with its bricks. Soft (not DELETE)
-- because edition blocks pin a specific version row via FK — deleting would
-- break already-sent / in-progress editions; flipping is_current just removes it
-- from the palette while keeping the version resolvable.
--
-- Two supporting changes:
--   * The block existence check is scoped to is_current=true, so a key that was
--     pruned and later reappears in the source inserts a fresh active row rather
--     than silently reviving a stale one.
--   * The returned summary gains `pruned_blocks`; in dry-run the count reflects
--     what WOULD be pruned without mutating.

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
AS $$
DECLARE
  v_library_id   uuid;
  v_library_kind text;
  v_source_kind  text;
  v_artifacts    jsonb := '[]'::jsonb;
  v_errors       jsonb := '[]'::jsonb;
  v_wrapper_count int := 0;
  v_block_count   int := 0;
  v_brick_count   int := 0;
  v_prune_count   int := 0;
  w_item         jsonb;
  b_item         jsonb;
  v_existing     record;
  v_existing_id  uuid;
  v_block_def_id uuid;
BEGIN
  SELECT s.library_id, s.kind, l.theme_kind
    INTO v_library_id, v_source_kind, v_library_kind
    FROM public.templates_sources s
    JOIN public.templates_libraries l ON l.id = s.library_id
   WHERE s.id = p_source_id;

  IF v_library_id IS NULL THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.source_not_found',
        'message', format('source %s does not exist', p_source_id)
      ))
    );
  END IF;

  -- Wrappers
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_wrappers, '[]'::jsonb))
  LOOP
    SELECT id, html, meta_block_keys, version
      INTO v_existing
      FROM public.templates_wrappers
     WHERE library_id = v_library_id AND key = (w_item->>'key') AND is_current = true;

    IF v_existing.id IS NULL THEN
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name',
                COALESCE(w_item->>'source_html', w_item->>'html', ''),
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb), 1, true);
      END IF;
      v_wrapper_count := v_wrapper_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'wrapper', 'key', w_item->>'key', 'action', 'inserted'));
    ELSIF v_existing.html = COALESCE(w_item->>'source_html', w_item->>'html', '') THEN
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'wrapper', 'key', w_item->>'key', 'action', 'unchanged'));
    ELSE
      IF NOT p_dry_run THEN
        UPDATE public.templates_wrappers SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name',
                COALESCE(w_item->>'source_html', w_item->>'html', ''),
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
                v_existing.version + 1, true);
      END IF;
      v_wrapper_count := v_wrapper_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'wrapper', 'key', w_item->>'key', 'action', 'updated'));
    END IF;
  END LOOP;

  -- Block defs
  FOR b_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb))
  LOOP
    SELECT id INTO v_existing_id
      FROM public.templates_block_defs
     WHERE library_id = v_library_id AND key = (b_item->>'key') AND is_current = true;

    IF v_existing_id IS NULL THEN
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_block_defs
          (library_id, key, name, description, schema, html, has_bricks, theme_kind)
        VALUES (v_library_id, b_item->>'key', b_item->>'name', b_item->>'description',
                COALESCE(b_item->'schema', '{}'::jsonb),
                COALESCE(b_item->>'html', ''),
                COALESCE((b_item->>'has_bricks')::boolean, false),
                v_library_kind)
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
           SET name        = b_item->>'name',
               description = b_item->>'description',
               schema      = COALESCE(b_item->'schema', '{}'::jsonb),
               html        = COALESCE(b_item->>'html', ''),
               has_bricks  = COALESCE((b_item->>'has_bricks')::boolean, false),
               updated_at  = now()
         WHERE id = v_block_def_id;
      END IF;
      v_block_count := v_block_count + 1;
      v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'block_def', 'key', b_item->>'key', 'action', 'updated', 'id', v_block_def_id));
    END IF;

    -- Brick defs nested under this block
    FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(b_item->'bricks', '[]'::jsonb))
    LOOP
      SELECT id INTO v_existing_id
        FROM public.templates_brick_defs
       WHERE block_def_id = v_block_def_id AND key = (w_item->>'key');

      IF v_existing_id IS NULL THEN
        IF NOT p_dry_run THEN
          INSERT INTO public.templates_brick_defs
            (block_def_id, key, name, schema, html, sort_order)
          VALUES (v_block_def_id, w_item->>'key', w_item->>'name',
                  COALESCE(w_item->'schema', '{}'::jsonb), w_item->>'html',
                  COALESCE((w_item->>'sort_order')::int, 0));
        END IF;
        v_brick_count := v_brick_count + 1;
        v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'brick_def', 'key', w_item->>'key', 'action', 'inserted'));
      ELSE
        IF NOT p_dry_run THEN
          UPDATE public.templates_brick_defs
             SET name       = w_item->>'name',
                 schema     = COALESCE(w_item->'schema', '{}'::jsonb),
                 html       = w_item->>'html',
                 sort_order = COALESCE((w_item->>'sort_order')::int, 0),
                 updated_at = now()
           WHERE id = v_existing_id;
        END IF;
        v_brick_count := v_brick_count + 1;
        v_artifacts := v_artifacts || jsonb_build_array(jsonb_build_object('kind', 'brick_def', 'key', w_item->>'key', 'action', 'updated'));
      END IF;
    END LOOP;
  END LOOP;

  -- ── Prune blocks removed from the source ──────────────────────────────────
  -- Any currently-active block whose key is absent from this parse is stale.
  SELECT count(*) INTO v_prune_count
    FROM public.templates_block_defs d
   WHERE d.library_id = v_library_id
     AND d.is_current = true
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) b
        WHERE b->>'key' = d.key
     );

  IF NOT p_dry_run AND v_prune_count > 0 THEN
    -- Deactivate the stale blocks' bricks first, then the blocks themselves.
    UPDATE public.templates_brick_defs br
       SET is_current = false, updated_at = now()
      FROM public.templates_block_defs d
     WHERE br.block_def_id = d.id
       AND br.is_current = true
       AND d.library_id = v_library_id
       AND d.is_current = true
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) b
          WHERE b->>'key' = d.key
       );

    UPDATE public.templates_block_defs d
       SET is_current = false, updated_at = now()
     WHERE d.library_id = v_library_id
       AND d.is_current = true
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) b
          WHERE b->>'key' = d.key
       );
  END IF;

  -- Update source's installed_sha
  IF NOT p_dry_run THEN
    UPDATE public.templates_sources
       SET inline_sha = COALESCE(p_source_sha, inline_sha),
           updated_at = now()
     WHERE id = p_source_id;
  END IF;

  RETURN jsonb_build_object(
    'artifacts', v_artifacts,
    'errors', v_errors,
    'summary', jsonb_build_object(
      'wrappers', v_wrapper_count,
      'block_defs', v_block_count,
      'brick_defs', v_brick_count,
      'pruned_blocks', v_prune_count
    )
  );
END;
$$;
