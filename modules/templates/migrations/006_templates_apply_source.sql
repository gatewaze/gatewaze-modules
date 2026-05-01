-- ============================================================================
-- Migration: templates_006_apply_source
-- Description: The transactional apply-source RPC. Takes parsed wrappers /
--              block_defs / definitions and writes them to the corresponding
--              tables, managing version pinning and source_artifacts.
--              All-or-nothing — any error rolls back the whole call.
--
--              Called from lib/sources/apply.ts.
-- ============================================================================

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
AS $$
DECLARE
  v_library_id uuid;
  v_artifacts  jsonb := '[]'::jsonb;
  v_errors     jsonb := '[]'::jsonb;

  -- Working state for inner loops
  w_item       jsonb;
  v_existing   record;
  v_new_id     uuid;
  v_action     text;
  v_brick      jsonb;
  v_block_id   uuid;
  v_keys_seen  text[] := ARRAY[]::text[];
BEGIN
  -- Resolve the library this source belongs to.
  SELECT library_id INTO v_library_id
    FROM public.templates_sources
   WHERE id = p_source_id;

  IF v_library_id IS NULL THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.source_not_found',
        'message', format('source %s does not exist', p_source_id)
      ))
    );
  END IF;

  IF p_source_sha IS NULL OR p_source_sha = '' THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.source_sha_required',
        'message', 'p_source_sha is required'
      ))
    );
  END IF;

  -- ============================================================
  -- 1. WRAPPERS
  -- ============================================================
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_wrappers, '[]'::jsonb)) LOOP
    SELECT id, html, meta_block_keys, global_seed_blocks, version
      INTO v_existing
      FROM public.templates_wrappers
     WHERE library_id = v_library_id
       AND key = (w_item->>'key')
       AND is_current = true
     LIMIT 1;

    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_wrappers
               (library_id, key, name, html, meta_block_keys, global_seed_blocks, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
                COALESCE(w_item->'global_seed_blocks', '[]'::jsonb),
                1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.html = (w_item->>'html')
          AND v_existing.meta_block_keys = COALESCE(w_item->'meta_block_keys', '[]'::jsonb)
          AND v_existing.global_seed_blocks = COALESCE(w_item->'global_seed_blocks', '[]'::jsonb) THEN
      v_action := 'unchanged';
      v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_wrappers SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_wrappers
               (library_id, key, name, html, meta_block_keys, global_seed_blocks, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
                COALESCE(w_item->'global_seed_blocks', '[]'::jsonb),
                v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;

    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts
             (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'wrapper', v_new_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;

    v_artifacts := v_artifacts || jsonb_build_object(
      'artifact_kind', 'wrapper',
      'key', w_item->>'key',
      'action', v_action,
      'artifact_id', v_new_id
    );

    v_keys_seen := v_keys_seen || ('wrapper:' || (w_item->>'key'));
  END LOOP;

  -- ============================================================
  -- 2. BLOCK_DEFS (and nested BRICKS)
  -- ============================================================
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) LOOP
    SELECT id, schema, html, rich_text_template, has_bricks, data_source, version
      INTO v_existing
      FROM public.templates_block_defs
     WHERE library_id = v_library_id
       AND key = (w_item->>'key')
       AND is_current = true
     LIMIT 1;

    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_block_defs
               (library_id, key, name, description, source_kind, schema, html, rich_text_template,
                has_bricks, data_source, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'description',
                CASE
                  WHEN (w_item->'data_source') IS NULL OR (w_item->'data_source') = 'null'::jsonb THEN 'static'
                  WHEN (w_item->'data_source'->>'adapter') = 'http' THEN 'external-api'
                  ELSE 'internal-content'
                END,
                COALESCE(w_item->'schema', '{}'::jsonb),
                w_item->>'html',
                w_item->>'rich_text_template',
                COALESCE((w_item->>'has_bricks')::boolean, false),
                NULLIF(w_item->'data_source', 'null'::jsonb),
                1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.schema = COALESCE(w_item->'schema', '{}'::jsonb)
          AND v_existing.html = (w_item->>'html')
          AND COALESCE(v_existing.rich_text_template, '') = COALESCE(w_item->>'rich_text_template', '')
          AND v_existing.has_bricks = COALESCE((w_item->>'has_bricks')::boolean, false)
          AND COALESCE(v_existing.data_source, '{}'::jsonb) = COALESCE(NULLIF(w_item->'data_source', 'null'::jsonb), '{}'::jsonb) THEN
      v_action := 'unchanged';
      v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_block_defs SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_block_defs
               (library_id, key, name, description, source_kind, schema, html, rich_text_template,
                has_bricks, data_source, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'description',
                CASE
                  WHEN (w_item->'data_source') IS NULL OR (w_item->'data_source') = 'null'::jsonb THEN 'static'
                  WHEN (w_item->'data_source'->>'adapter') = 'http' THEN 'external-api'
                  ELSE 'internal-content'
                END,
                COALESCE(w_item->'schema', '{}'::jsonb),
                w_item->>'html',
                w_item->>'rich_text_template',
                COALESCE((w_item->>'has_bricks')::boolean, false),
                NULLIF(w_item->'data_source', 'null'::jsonb),
                v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;

    v_block_id := v_new_id;

    -- Bricks (only if has_bricks=true and the action is not 'unchanged')
    IF NOT p_dry_run AND v_action <> 'unchanged' AND COALESCE((w_item->>'has_bricks')::boolean, false) THEN
      -- Brick rows are scoped to a specific block-def version row, so for a
      -- fresh block (added or bumped) we always insert all bricks fresh.
      FOR v_brick IN SELECT * FROM jsonb_array_elements(COALESCE(w_item->'bricks', '[]'::jsonb)) LOOP
        INSERT INTO public.templates_brick_defs
               (block_def_id, key, name, schema, html, rich_text_template, sort_order)
        VALUES (v_block_id,
                v_brick->>'key',
                v_brick->>'name',
                COALESCE(v_brick->'schema', '{}'::jsonb),
                v_brick->>'html',
                v_brick->>'rich_text_template',
                COALESCE((v_brick->>'sort_order')::int, 0));
        -- We don't add per-brick source_artifact rows here because bricks
        -- cascade-delete with their parent block-def; the parent's artifact
        -- entry covers the whole block (including its bricks).
      END LOOP;
    END IF;

    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts
             (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'block_def', v_block_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;

    v_artifacts := v_artifacts || jsonb_build_object(
      'artifact_kind', 'block_def',
      'key', w_item->>'key',
      'action', v_action,
      'artifact_id', v_block_id
    );

    v_keys_seen := v_keys_seen || ('block_def:' || (w_item->>'key'));
  END LOOP;

  -- ============================================================
  -- 3. DEFINITIONS
  -- ============================================================
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_definitions, '[]'::jsonb)) LOOP
    SELECT id, source_html, parsed_blocks, default_block_order, meta_block_keys, version
      INTO v_existing
      FROM public.templates_definitions
     WHERE library_id = v_library_id
       AND key = (w_item->>'key')
       AND is_current = true
     LIMIT 1;

    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_definitions
               (library_id, key, name, source_html, parsed_blocks, default_block_order, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'source_html',
                COALESCE(w_item->'parsed_blocks', '[]'::jsonb),
                COALESCE(w_item->'default_block_order', '[]'::jsonb),
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
                1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.source_html = (w_item->>'source_html')
          AND v_existing.parsed_blocks = COALESCE(w_item->'parsed_blocks', '[]'::jsonb)
          AND v_existing.default_block_order = COALESCE(w_item->'default_block_order', '[]'::jsonb)
          AND v_existing.meta_block_keys = COALESCE(w_item->'meta_block_keys', '[]'::jsonb) THEN
      v_action := 'unchanged';
      v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_definitions SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_definitions
               (library_id, key, name, source_html, parsed_blocks, default_block_order, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'source_html',
                COALESCE(w_item->'parsed_blocks', '[]'::jsonb),
                COALESCE(w_item->'default_block_order', '[]'::jsonb),
                COALESCE(w_item->'meta_block_keys', '[]'::jsonb),
                v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;

    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts
             (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'definition', v_new_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;

    v_artifacts := v_artifacts || jsonb_build_object(
      'artifact_kind', 'definition',
      'key', w_item->>'key',
      'action', v_action,
      'artifact_id', v_new_id
    );

    v_keys_seen := v_keys_seen || ('definition:' || (w_item->>'key'));
  END LOOP;

  -- ============================================================
  -- 4. Detach artifacts no longer present in the parse
  -- ============================================================
  -- Mark previously-applied artifacts as detached when the new parse
  -- doesn't include them. Rows themselves stay (so existing references
  -- continue to work); detached_at signals "no longer maintained by source".
  IF NOT p_dry_run THEN
    UPDATE public.templates_source_artifacts AS sa
       SET detached_at = now()
      WHERE sa.source_id = p_source_id
        AND sa.detached_at IS NULL
        AND NOT (
          (sa.artifact_kind || ':' || (
            CASE sa.artifact_kind
              WHEN 'wrapper'    THEN (SELECT key FROM public.templates_wrappers    WHERE id = sa.artifact_id)
              WHEN 'block_def'  THEN (SELECT key FROM public.templates_block_defs  WHERE id = sa.artifact_id)
              WHEN 'definition' THEN (SELECT key FROM public.templates_definitions WHERE id = sa.artifact_id)
            END
          )) = ANY(v_keys_seen)
        );
  END IF;

  -- ============================================================
  -- 5. Update the source row's installed_git_sha (or upload_sha / inline_sha
  --    depending on kind). The router does this for git; for upload/inline
  --    apply, this is the canonical source-of-truth update.
  -- ============================================================
  IF NOT p_dry_run THEN
    UPDATE public.templates_sources
       SET installed_git_sha = CASE WHEN kind = 'git' THEN p_source_sha ELSE installed_git_sha END,
           available_git_sha = CASE WHEN kind = 'git' THEN NULL ELSE available_git_sha END,
           upload_sha        = CASE WHEN kind = 'upload' THEN p_source_sha ELSE upload_sha END,
           inline_sha        = CASE WHEN kind = 'inline' THEN p_source_sha ELSE inline_sha END
     WHERE id = p_source_id;
  END IF;

  RETURN jsonb_build_object(
    'artifacts', v_artifacts,
    'errors',    v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.templates_apply_source(uuid, text, jsonb, jsonb, jsonb, boolean) IS
  'Transactional apply: writes wrappers / block_defs / definitions from a parse. Manages version pinning and source_artifacts. Returns { artifacts, errors }.';
