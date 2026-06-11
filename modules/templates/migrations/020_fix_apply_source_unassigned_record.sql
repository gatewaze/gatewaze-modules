-- 020_fix_apply_source_unassigned_record
--
-- Fix: templates_apply_source raised
--   "record \"v_existing\" is not assigned yet"
-- whenever a source contained block_defs but NO wrappers (e.g. a newsletter
-- template that declares <!-- BLOCK:... --> markers with no WRAPPER marker).
--
-- The block-def and brick-def loops did `SELECT id INTO v_existing.id`, which
-- assigns into a FIELD of the `record` variable v_existing. That is only legal
-- once v_existing has a known row structure — which it only gets from the
-- wrappers loop's `SELECT ... INTO v_existing`. With zero wrappers that loop
-- never runs, v_existing stays unassigned, and touching `v_existing.id` throws.
--
-- Use a dedicated scalar uuid (`v_existing_id`) for the block/brick existence
-- checks instead. The wrappers loop still uses the full `v_existing` record.

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
     WHERE library_id = v_library_id AND key = (b_item->>'key');

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
      'brick_defs', v_brick_count
    )
  );
END;
$$;
