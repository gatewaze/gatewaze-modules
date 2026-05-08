-- ============================================================================
-- Migration: templates_017_unify_theme_kinds
-- Description: Drops the rigid separation between theme_kind='website' and
--              theme_kind='email' for HTML-shaped artifacts (block_defs,
--              brick_defs, wrappers). Both kinds now coexist on a single
--              library so a website can be authored via the visual canvas
--              the same way email/newsletter is. The platform's renderer
--              still chooses Next.js vs flat-HTML output based on the
--              host's deployment configuration — that's a publish-time
--              concern, not an authoring-time one.
--
-- Three changes:
--   1. templates_apply_source RPC no longer rejects website libraries
--      (was added in templates_008 / templates_013).
--   2. The block_defs theme_kind enforcement trigger is loosened: it
--      still defaults a missing theme_kind to the library's, but does
--      not reject a mismatch — the canvas serves block_defs regardless
--      of theme_kind, so a website lib can have email-marked block_defs
--      and vice versa.
--   3. Wrappers + brick_defs follow the same loosened rule.
--
-- Safe on existing rows: no data is changed. Only triggers + the apply
-- RPC are replaced.
-- Per follow-up to spec-host-media-module + spec-sites-wysiwyg-builder.
-- ============================================================================

-- 1. Loosen the block_defs theme_kind trigger (originally created in 013).
CREATE OR REPLACE FUNCTION public.templates_block_defs_theme_kind_check()
RETURNS trigger AS $$
DECLARE
  v_library_kind text;
BEGIN
  SELECT theme_kind INTO v_library_kind
    FROM public.templates_libraries
   WHERE id = NEW.library_id;

  IF v_library_kind IS NULL THEN
    RAISE EXCEPTION 'library not found: %', NEW.library_id;
  END IF;

  -- If the caller relied on the column default, inherit from the library.
  -- If the caller passed an explicit value, accept it (cross-kind block_defs
  -- are now allowed — the canvas reads block_defs by library_id only).
  IF TG_OP = 'INSERT' AND (NEW.theme_kind IS NULL OR NEW.theme_kind = '') THEN
    NEW.theme_kind = v_library_kind;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Replace the apply_source RPC to skip the website-rejection branch.
-- We keep the body of the original (creating wrappers / block_defs / brick_defs
-- artifacts) and just remove the early-return that blocks website libs.
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

  -- (theme_kind website-rejection removed in templates_017_unify_theme_kinds.)

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
    SELECT id INTO v_existing.id
      FROM public.templates_block_defs
     WHERE library_id = v_library_id AND key = (b_item->>'key');

    IF v_existing.id IS NULL THEN
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
      v_block_def_id := v_existing.id;
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
      SELECT id INTO v_existing.id
        FROM public.templates_brick_defs
       WHERE block_def_id = v_block_def_id AND key = (w_item->>'key');

      IF v_existing.id IS NULL THEN
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
           WHERE id = v_existing.id;
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
