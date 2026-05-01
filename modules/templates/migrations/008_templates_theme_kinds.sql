-- ============================================================================
-- Migration: templates_008_theme_kinds
-- Description: Annex per spec-sites-theme-kinds.md. Adds the discriminator
--              `theme_kind: 'html' | 'nextjs'` to templates_sources,
--              templates_libraries, templates_block_defs. Defaults to 'html'
--              so existing rows are unchanged. Enforces:
--                - inheritance: source → library, library → block_def on INSERT
--                - immutability: theme_kind cannot be UPDATEd after insert
--
--              The Next.js path (theme_kind='nextjs') ingests a content
--              schema instead of marker grammar; tables backing that path
--              land in a separate migration once the consumer (sites)
--              installs them.
-- ============================================================================

-- ==========================================================================
-- 1. ADD COLUMN with default + CHECK constraint on each table
-- ==========================================================================

ALTER TABLE public.templates_sources
  ADD COLUMN IF NOT EXISTS theme_kind text NOT NULL DEFAULT 'html'
    CHECK (theme_kind IN ('html', 'nextjs'));

ALTER TABLE public.templates_libraries
  ADD COLUMN IF NOT EXISTS theme_kind text NOT NULL DEFAULT 'html'
    CHECK (theme_kind IN ('html', 'nextjs'));

ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS theme_kind text NOT NULL DEFAULT 'html'
    CHECK (theme_kind IN ('html', 'nextjs'));

-- ==========================================================================
-- 2. Immutability — theme_kind cannot change after insert
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.templates_theme_kind_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.theme_kind IS DISTINCT FROM OLD.theme_kind THEN
    RAISE EXCEPTION 'cannot_change_theme_kind: theme_kind is immutable on % rows (was %, attempted %)',
      TG_TABLE_NAME, OLD.theme_kind, NEW.theme_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_sources_theme_kind_immutable
  BEFORE UPDATE OF theme_kind ON public.templates_sources
  FOR EACH ROW EXECUTE FUNCTION public.templates_theme_kind_immutable();

CREATE TRIGGER templates_libraries_theme_kind_immutable
  BEFORE UPDATE OF theme_kind ON public.templates_libraries
  FOR EACH ROW EXECUTE FUNCTION public.templates_theme_kind_immutable();

CREATE TRIGGER templates_block_defs_theme_kind_immutable
  BEFORE UPDATE OF theme_kind ON public.templates_block_defs
  FOR EACH ROW EXECUTE FUNCTION public.templates_theme_kind_immutable();

-- ==========================================================================
-- 3. Inheritance — source.theme_kind → library.theme_kind on INSERT
-- ==========================================================================
-- A library is created in concert with a host (newsletters/sites/etc.); the
-- creator passes the desired theme_kind. But if it's not passed (defaults to
-- 'html'), and the library is created from a source's apply flow, we want
-- the source's theme_kind to propagate.
--
-- Today there's no FK from libraries to a single source — sources are
-- attached to libraries, not the other way. So this trigger is a
-- defensive "if a block_def is being inserted into a library, its
-- theme_kind must match the library's theme_kind" check.

CREATE OR REPLACE FUNCTION public.templates_block_defs_inherit_theme_kind()
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

  -- If the caller didn't set theme_kind explicitly (i.e. it's the column
  -- default 'html'), inherit from the library. If they did set it to
  -- something specific, validate it matches.
  IF TG_OP = 'INSERT' THEN
    IF NEW.theme_kind = 'html' AND v_library_kind <> 'html' THEN
      -- Caller relied on the column default; inherit from library.
      NEW.theme_kind = v_library_kind;
    ELSIF NEW.theme_kind <> v_library_kind THEN
      RAISE EXCEPTION 'theme_kind_mismatch: block_def.theme_kind=% but library.theme_kind=%',
        NEW.theme_kind, v_library_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_block_defs_inherit_theme_kind
  BEFORE INSERT ON public.templates_block_defs
  FOR EACH ROW EXECUTE FUNCTION public.templates_block_defs_inherit_theme_kind();

-- ==========================================================================
-- 4. Apply-source RPC: refuse to apply HTML-shaped artifacts to nextjs libs
-- ==========================================================================
-- The existing templates_apply_source RPC (migration 006) writes wrappers
-- and block_defs into a library. For theme_kind='nextjs' libraries, those
-- artifacts are never produced (the Next.js ingest path produces
-- templates_content_schemas rows instead). But if an admin attaches an
-- HTML upload source to a nextjs library by mistake, the apply call would
-- succeed and pollute the library.
--
-- The simplest defense: reject the apply at the RPC entry by checking the
-- library's theme_kind. Done as a wrapper around the existing function so
-- migration 006 stays unchanged.

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
  v_library_id   uuid;
  v_library_kind text;
  v_source_kind  text;
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

  IF v_library_kind = 'nextjs' THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.theme_kind_mismatch',
        'message', format(
          'source %s is being applied to library %s (theme_kind=nextjs); HTML-shaped artifacts (wrappers/block_defs/definitions) are rejected. Next.js sources produce templates_content_schemas rows via a separate ingest path.',
          p_source_id, v_library_id)
      ))
    );
  END IF;

  -- Delegate to the underlying implementation. We rename the original
  -- function (in migration 006) to _impl and call it here. Since 006 ships
  -- before 008, we need to do this rename without breaking 006's behavior
  -- on a fresh install. The trick: redefine the public function here
  -- (above), and define a new private function below that holds the
  -- implementation body. The original function created in 006 is shadowed
  -- by this CREATE OR REPLACE.
  RETURN public.templates_apply_source_impl(
    p_source_id, p_source_sha, p_wrappers, p_block_defs, p_definitions, p_dry_run
  );
END;
$$;

-- The original implementation is kept in a private function. On fresh
-- installs (where 006 + 008 run together), the body is identical to 006.
-- On upgrades from a system that already has 006 applied, this CREATE OR
-- REPLACE supersedes the old definition. The implementation body is
-- copied from migration 006 verbatim — DO NOT MODIFY here; modify 006
-- and re-run both migrations in order.

CREATE OR REPLACE FUNCTION public.templates_apply_source_impl(
  p_source_id  uuid,
  p_source_sha text,
  p_wrappers   jsonb,
  p_block_defs jsonb,
  p_definitions jsonb,
  p_dry_run    boolean
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_library_id uuid;
  v_artifacts  jsonb := '[]'::jsonb;
  v_errors     jsonb := '[]'::jsonb;
  w_item       jsonb;
  v_existing   record;
  v_new_id     uuid;
  v_action     text;
  v_brick      jsonb;
  v_block_id   uuid;
  v_keys_seen  text[] := ARRAY[]::text[];
BEGIN
  SELECT library_id INTO v_library_id FROM public.templates_sources WHERE id = p_source_id;
  IF v_library_id IS NULL THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object('code','templates.apply.source_not_found','message',format('source %s does not exist', p_source_id)))
    );
  END IF;
  IF p_source_sha IS NULL OR p_source_sha = '' THEN
    RETURN jsonb_build_object('artifacts','[]'::jsonb,'errors',jsonb_build_array(jsonb_build_object('code','templates.apply.source_sha_required','message','p_source_sha is required')));
  END IF;

  -- WRAPPERS
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_wrappers, '[]'::jsonb)) LOOP
    SELECT id, html, meta_block_keys, global_seed_blocks, version INTO v_existing
      FROM public.templates_wrappers
     WHERE library_id = v_library_id AND key = (w_item->>'key') AND is_current = true LIMIT 1;
    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, global_seed_blocks, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
          COALESCE(w_item->'meta_block_keys','[]'::jsonb), COALESCE(w_item->'global_seed_blocks','[]'::jsonb), 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.html = (w_item->>'html')
       AND v_existing.meta_block_keys = COALESCE(w_item->'meta_block_keys','[]'::jsonb)
       AND v_existing.global_seed_blocks = COALESCE(w_item->'global_seed_blocks','[]'::jsonb) THEN
      v_action := 'unchanged'; v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_wrappers SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_wrappers
          (library_id, key, name, html, meta_block_keys, global_seed_blocks, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'html',
          COALESCE(w_item->'meta_block_keys','[]'::jsonb), COALESCE(w_item->'global_seed_blocks','[]'::jsonb),
          v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;
    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'wrapper', v_new_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;
    v_artifacts := v_artifacts || jsonb_build_object('artifact_kind','wrapper','key',w_item->>'key','action',v_action,'artifact_id',v_new_id);
    v_keys_seen := v_keys_seen || ('wrapper:' || (w_item->>'key'));
  END LOOP;

  -- BLOCK_DEFS (and BRICKS)
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_block_defs, '[]'::jsonb)) LOOP
    SELECT id, schema, html, rich_text_template, has_bricks, data_source, version INTO v_existing
      FROM public.templates_block_defs
     WHERE library_id = v_library_id AND key = (w_item->>'key') AND is_current = true LIMIT 1;
    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_block_defs
          (library_id, key, name, description, source_kind, schema, html, rich_text_template, has_bricks, data_source, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'description',
          CASE WHEN (w_item->'data_source') IS NULL OR (w_item->'data_source')='null'::jsonb THEN 'static'
               WHEN (w_item->'data_source'->>'adapter')='http' THEN 'external-api' ELSE 'internal-content' END,
          COALESCE(w_item->'schema','{}'::jsonb), w_item->>'html', w_item->>'rich_text_template',
          COALESCE((w_item->>'has_bricks')::boolean, false),
          NULLIF(w_item->'data_source','null'::jsonb), 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.schema = COALESCE(w_item->'schema','{}'::jsonb)
      AND v_existing.html = (w_item->>'html')
      AND COALESCE(v_existing.rich_text_template,'') = COALESCE(w_item->>'rich_text_template','')
      AND v_existing.has_bricks = COALESCE((w_item->>'has_bricks')::boolean, false)
      AND COALESCE(v_existing.data_source,'{}'::jsonb) = COALESCE(NULLIF(w_item->'data_source','null'::jsonb),'{}'::jsonb) THEN
      v_action := 'unchanged'; v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_block_defs SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_block_defs
          (library_id, key, name, description, source_kind, schema, html, rich_text_template, has_bricks, data_source, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'description',
          CASE WHEN (w_item->'data_source') IS NULL OR (w_item->'data_source')='null'::jsonb THEN 'static'
               WHEN (w_item->'data_source'->>'adapter')='http' THEN 'external-api' ELSE 'internal-content' END,
          COALESCE(w_item->'schema','{}'::jsonb), w_item->>'html', w_item->>'rich_text_template',
          COALESCE((w_item->>'has_bricks')::boolean, false),
          NULLIF(w_item->'data_source','null'::jsonb), v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;
    v_block_id := v_new_id;
    IF NOT p_dry_run AND v_action <> 'unchanged' AND COALESCE((w_item->>'has_bricks')::boolean, false) THEN
      FOR v_brick IN SELECT * FROM jsonb_array_elements(COALESCE(w_item->'bricks', '[]'::jsonb)) LOOP
        INSERT INTO public.templates_brick_defs
          (block_def_id, key, name, schema, html, rich_text_template, sort_order)
        VALUES (v_block_id, v_brick->>'key', v_brick->>'name',
          COALESCE(v_brick->'schema','{}'::jsonb), v_brick->>'html', v_brick->>'rich_text_template',
          COALESCE((v_brick->>'sort_order')::int, 0));
      END LOOP;
    END IF;
    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'block_def', v_block_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;
    v_artifacts := v_artifacts || jsonb_build_object('artifact_kind','block_def','key',w_item->>'key','action',v_action,'artifact_id',v_block_id);
    v_keys_seen := v_keys_seen || ('block_def:' || (w_item->>'key'));
  END LOOP;

  -- DEFINITIONS
  FOR w_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_definitions, '[]'::jsonb)) LOOP
    SELECT id, source_html, parsed_blocks, default_block_order, meta_block_keys, version INTO v_existing
      FROM public.templates_definitions
     WHERE library_id = v_library_id AND key = (w_item->>'key') AND is_current = true LIMIT 1;
    IF NOT FOUND THEN
      v_action := 'added';
      IF NOT p_dry_run THEN
        INSERT INTO public.templates_definitions
          (library_id, key, name, source_html, parsed_blocks, default_block_order, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'source_html',
          COALESCE(w_item->'parsed_blocks','[]'::jsonb), COALESCE(w_item->'default_block_order','[]'::jsonb),
          COALESCE(w_item->'meta_block_keys','[]'::jsonb), 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    ELSIF v_existing.source_html = (w_item->>'source_html')
       AND v_existing.parsed_blocks = COALESCE(w_item->'parsed_blocks','[]'::jsonb)
       AND v_existing.default_block_order = COALESCE(w_item->'default_block_order','[]'::jsonb)
       AND v_existing.meta_block_keys = COALESCE(w_item->'meta_block_keys','[]'::jsonb) THEN
      v_action := 'unchanged'; v_new_id := v_existing.id;
    ELSE
      v_action := 'bumped';
      IF NOT p_dry_run THEN
        UPDATE public.templates_definitions SET is_current = false WHERE id = v_existing.id;
        INSERT INTO public.templates_definitions
          (library_id, key, name, source_html, parsed_blocks, default_block_order, meta_block_keys, version, is_current)
        VALUES (v_library_id, w_item->>'key', w_item->>'name', w_item->>'source_html',
          COALESCE(w_item->'parsed_blocks','[]'::jsonb), COALESCE(w_item->'default_block_order','[]'::jsonb),
          COALESCE(w_item->'meta_block_keys','[]'::jsonb), v_existing.version + 1, true)
        RETURNING id INTO v_new_id;
      END IF;
    END IF;
    IF NOT p_dry_run AND v_action <> 'unchanged' THEN
      INSERT INTO public.templates_source_artifacts (source_id, artifact_kind, artifact_id, source_sha)
      VALUES (p_source_id, 'definition', v_new_id, p_source_sha)
      ON CONFLICT (source_id, artifact_kind, artifact_id) DO UPDATE
        SET source_sha = EXCLUDED.source_sha, applied_at = now(), detached_at = NULL;
    END IF;
    v_artifacts := v_artifacts || jsonb_build_object('artifact_kind','definition','key',w_item->>'key','action',v_action,'artifact_id',v_new_id);
    v_keys_seen := v_keys_seen || ('definition:' || (w_item->>'key'));
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE public.templates_source_artifacts AS sa
       SET detached_at = now()
     WHERE sa.source_id = p_source_id AND sa.detached_at IS NULL
       AND NOT (
         (sa.artifact_kind || ':' || (
           CASE sa.artifact_kind
             WHEN 'wrapper'    THEN (SELECT key FROM public.templates_wrappers    WHERE id = sa.artifact_id)
             WHEN 'block_def'  THEN (SELECT key FROM public.templates_block_defs  WHERE id = sa.artifact_id)
             WHEN 'definition' THEN (SELECT key FROM public.templates_definitions WHERE id = sa.artifact_id)
           END
         )) = ANY(v_keys_seen)
       );
    UPDATE public.templates_sources
       SET installed_git_sha = CASE WHEN kind = 'git' THEN p_source_sha ELSE installed_git_sha END,
           available_git_sha = CASE WHEN kind = 'git' THEN NULL ELSE available_git_sha END,
           upload_sha        = CASE WHEN kind = 'upload' THEN p_source_sha ELSE upload_sha END,
           inline_sha        = CASE WHEN kind = 'inline' THEN p_source_sha ELSE inline_sha END
     WHERE id = p_source_id;
  END IF;

  RETURN jsonb_build_object('artifacts', v_artifacts, 'errors', v_errors);
END;
$$;
