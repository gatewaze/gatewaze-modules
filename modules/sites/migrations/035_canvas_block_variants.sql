-- ============================================================================
-- Migration: sites_035_canvas_block_variants
-- Description: Multi-variant content storage for canvas blocks/bricks. Per
--              spec-sites-wysiwyg-builder §5.1 deferred follow-up. The
--              `variant_key` column on page_blocks / page_block_bricks
--              previously selected which variant to RENDER but every block
--              had a single content payload — that was insufficient for
--              real A/B testing where the variant alters block content.
--
-- This migration adds:
--   - page_block_variants(page_block_id, variant_key, content)
--   - page_block_brick_variants(page_block_brick_id, variant_key, content)
--   - canvas_upsert_block_variant(p_block_id, p_variant_key, p_content)
--   - canvas_upsert_brick_variant(p_brick_id, p_variant_key, p_content)
--   - GET helpers for canvas-routes to load variant overrides cheaply
--
-- Migration semantics: page_blocks.content stays as the "default" / "control"
-- payload. When a renderer is asked for a non-default variant_key it
-- looks up page_block_variants(page_block_id, variant_key) and falls back
-- to page_blocks.content if no override exists. This is fully backwards
-- compatible: every existing block reads identically when variant_key is
-- 'default' (or unset).
--
-- Idempotent: gated by IF NOT EXISTS / OR REPLACE.
-- ============================================================================

-- ==========================================================================
-- 1. page_block_variants — content overrides per variant_key per block.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_block_variants (
  page_block_id  uuid NOT NULL REFERENCES public.page_blocks(id) ON DELETE CASCADE,
  variant_key    text NOT NULL CHECK (length(variant_key) BETWEEN 1 AND 64),
  content        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_block_id, variant_key)
);

COMMENT ON TABLE public.page_block_variants IS
  'Per-variant content overrides for a page_block. The "default" variant_key reads from page_blocks.content; non-default variants live here. Per spec-sites-wysiwyg-builder §5.1 multi-variant rendering follow-up.';

COMMENT ON COLUMN public.page_block_variants.variant_key IS
  'Matches page_blocks.variant_key; identifies which A/B test arm this content belongs to. Reserved value "default" is NOT stored here — page_blocks.content is the default content.';

-- ==========================================================================
-- 2. page_block_brick_variants — same model for bricks.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_block_brick_variants (
  page_block_brick_id  uuid NOT NULL REFERENCES public.page_block_bricks(id) ON DELETE CASCADE,
  variant_key          text NOT NULL CHECK (length(variant_key) BETWEEN 1 AND 64),
  content              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_block_brick_id, variant_key)
);

COMMENT ON TABLE public.page_block_brick_variants IS
  'Per-variant content overrides for a page_block_brick. Mirrors page_block_variants. Per spec-sites-wysiwyg-builder §5.1.';

-- ==========================================================================
-- 3. RLS — match the parent tables. Service role bypasses; authenticated
--    users get permission via the canvas_apply_ops SECURITY DEFINER path.
-- ==========================================================================

ALTER TABLE public.page_block_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_block_brick_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS page_block_variants_service_role_all ON public.page_block_variants;
CREATE POLICY page_block_variants_service_role_all ON public.page_block_variants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS page_block_brick_variants_service_role_all ON public.page_block_brick_variants;
CREATE POLICY page_block_brick_variants_service_role_all ON public.page_block_brick_variants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users: same can_admin_site check that gates page_blocks.
DROP POLICY IF EXISTS page_block_variants_admin_select ON public.page_block_variants;
CREATE POLICY page_block_variants_admin_select ON public.page_block_variants
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.page_blocks pb
        JOIN public.pages p ON p.id = pb.page_id
       WHERE pb.id = page_block_variants.page_block_id
         AND p.host_kind = 'site'
         AND public.can_admin_site(p.host_id)
    )
  );

DROP POLICY IF EXISTS page_block_brick_variants_admin_select ON public.page_block_brick_variants;
CREATE POLICY page_block_brick_variants_admin_select ON public.page_block_brick_variants
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.page_block_bricks bk
        JOIN public.page_blocks pb ON pb.id = bk.page_block_id
        JOIN public.pages p        ON p.id  = pb.page_id
       WHERE bk.id = page_block_brick_variants.page_block_brick_id
         AND p.host_kind = 'site'
         AND public.can_admin_site(p.host_id)
    )
  );

-- ==========================================================================
-- 4. canvas_upsert_block_variant / canvas_upsert_brick_variant — the
--    canvas op handlers call these via the canvas_apply_ops SQL
--    function. Both are SECURITY DEFINER so the authenticated caller
--    needs only the RPC privilege, not direct write access.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.canvas_upsert_block_variant(
  p_block_id    uuid,
  p_variant_key text,
  p_content     jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_variant_key = 'default' THEN
    -- The "default" variant lives in page_blocks.content directly.
    UPDATE public.page_blocks SET content = p_content WHERE id = p_block_id;
    RETURN;
  END IF;
  INSERT INTO public.page_block_variants (page_block_id, variant_key, content, updated_at)
  VALUES (p_block_id, p_variant_key, p_content, now())
  ON CONFLICT (page_block_id, variant_key)
  DO UPDATE SET content = EXCLUDED.content, updated_at = now();
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_upsert_block_variant(uuid, text, jsonb) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.canvas_upsert_brick_variant(
  p_brick_id    uuid,
  p_variant_key text,
  p_content     jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_variant_key = 'default' THEN
    UPDATE public.page_block_bricks SET content = p_content WHERE id = p_brick_id;
    RETURN;
  END IF;
  INSERT INTO public.page_block_brick_variants (page_block_brick_id, variant_key, content, updated_at)
  VALUES (p_brick_id, p_variant_key, p_content, now())
  ON CONFLICT (page_block_brick_id, variant_key)
  DO UPDATE SET content = EXCLUDED.content, updated_at = now();
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_upsert_brick_variant(uuid, text, jsonb) TO service_role, authenticated;

-- ==========================================================================
-- 5. Index — lookup by (page_block_id, variant_key) for the renderer.
-- ==========================================================================

-- Implied by PRIMARY KEY (page_block_id, variant_key); explicit comment.
COMMENT ON INDEX public.page_block_variants_pkey IS
  'Renderer hot-path lookup: (page_block_id, variant_key) → content override.';

COMMENT ON INDEX public.page_block_brick_variants_pkey IS
  'Renderer hot-path lookup: (page_block_brick_id, variant_key) → content override.';

-- ==========================================================================
-- 6. Op-handler functions for the new ops:
--    - block.upsert_variant_content
--    - brick.upsert_variant_content
--    Both share the canvas_apply_ops transactional envelope (called from
--    the dispatcher below). They inherit the lock + version checks.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public._canvas_apply_block_upsert_variant_content(
  p_page_id uuid,
  p_op      jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_id      uuid;
  v_variant_key   text;
  v_block_page_id uuid;
  v_content       jsonb;
BEGIN
  v_block_id    := (p_op->>'blockId')::uuid;
  v_variant_key := p_op->>'variantKey';
  v_content     := p_op->'content';

  IF v_variant_key IS NULL OR length(v_variant_key) = 0 OR length(v_variant_key) > 64 THEN
    RAISE EXCEPTION 'canvas.invalid_op: variantKey must be 1..64 chars'
      USING ERRCODE = '22023';
  END IF;

  SELECT page_id INTO v_block_page_id FROM public.page_blocks WHERE id = v_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: block % does not belong to page %', v_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.canvas_upsert_block_variant(v_block_id, v_variant_key, COALESCE(v_content, '{}'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public._canvas_apply_brick_upsert_variant_content(
  p_page_id uuid,
  p_op      jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_brick_id      uuid;
  v_variant_key   text;
  v_brick_page_id uuid;
  v_content       jsonb;
BEGIN
  v_brick_id    := (p_op->>'brickId')::uuid;
  v_variant_key := p_op->>'variantKey';
  v_content     := p_op->'content';

  IF v_variant_key IS NULL OR length(v_variant_key) = 0 OR length(v_variant_key) > 64 THEN
    RAISE EXCEPTION 'canvas.invalid_op: variantKey must be 1..64 chars'
      USING ERRCODE = '22023';
  END IF;

  -- Brick → block → page chain check.
  SELECT pb.page_id INTO v_brick_page_id
    FROM public.page_block_bricks bk
    JOIN public.page_blocks pb ON pb.id = bk.page_block_id
   WHERE bk.id = v_brick_id;
  IF v_brick_page_id IS NULL OR v_brick_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: brick % does not belong to page %', v_brick_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.canvas_upsert_brick_variant(v_brick_id, v_variant_key, COALESCE(v_content, '{}'::jsonb));
END $$;

-- ==========================================================================
-- 7. Replace canvas_apply_ops to add the new dispatch entries. Body is
--    identical to migration 033 except for the two new ELSIF branches.
--    Keeping the full function inline (not a callback) so the dispatch
--    is locally inspectable.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.canvas_apply_ops(
  p_page_id        uuid,
  p_base_version   integer,
  p_client_token   text,
  p_editor_id      uuid,
  p_ops            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actual_version integer;
  v_lock_editor    uuid;
  v_lock_token     text;
  v_library_id     uuid;
  v_op             jsonb;
  v_op_kind        text;
  v_warnings       jsonb := '[]'::jsonb;
  v_block_count    integer;
BEGIN
  BEGIN
    -- pages now carries templates_library_id directly (host_kind/host_id
    -- model superseded the old pages.site_id FK), so read it from the page
    -- rather than joining sites on a column that no longer exists.
    SELECT p.version, l.editor_id, l.client_token, p.templates_library_id
      INTO v_actual_version, v_lock_editor, v_lock_token, v_library_id
      FROM public.pages p
      LEFT JOIN public.page_canvas_locks l ON l.page_id = p.id
     WHERE p.id = p_page_id
     FOR UPDATE OF p NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'canvas.version_conflict',
        'message', 'page is being modified by another transaction'
      ));
  END;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'not_found', 'message', 'page not found'
    ));
  END IF;

  IF v_actual_version <> p_base_version THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'canvas.version_conflict', 'actualVersion', v_actual_version
    ));
  END IF;

  IF v_lock_editor IS NULL OR v_lock_editor <> p_editor_id OR v_lock_token <> p_client_token THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'canvas.lock_not_held',
      'message', 'caller does not hold the canvas lock for this page'
    ));
  END IF;

  IF v_library_id IS NULL THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'canvas.no_library',
      'message', 'site has no templates_library_id; bind a library before editing'
    ));
  END IF;

  FOR v_op IN SELECT * FROM jsonb_array_elements(p_ops) LOOP
    v_op_kind := v_op->>'kind';

    IF v_op_kind = 'block.insert' THEN
      PERFORM public._canvas_apply_block_insert(p_page_id, v_library_id, v_op);
    ELSIF v_op_kind = 'block.move' THEN
      PERFORM public._canvas_apply_block_move(p_page_id, v_op);
    ELSIF v_op_kind = 'block.delete' THEN
      PERFORM public._canvas_apply_block_delete(p_page_id, v_op);
    ELSIF v_op_kind = 'block.update_field' THEN
      PERFORM public._canvas_apply_block_update_field(p_page_id, v_op);
    ELSIF v_op_kind = 'block.set_variant' THEN
      PERFORM public._canvas_apply_block_set_variant(p_page_id, v_op);
    ELSIF v_op_kind = 'block.upsert_variant_content' THEN
      PERFORM public._canvas_apply_block_upsert_variant_content(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.insert' THEN
      PERFORM public._canvas_apply_brick_insert(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.move' THEN
      PERFORM public._canvas_apply_brick_move(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.delete' THEN
      PERFORM public._canvas_apply_brick_delete(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.update_field' THEN
      PERFORM public._canvas_apply_brick_update_field(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.upsert_variant_content' THEN
      PERFORM public._canvas_apply_brick_upsert_variant_content(p_page_id, v_op);
    ELSIF v_op_kind = 'preset.apply' THEN
      PERFORM public._canvas_apply_preset(p_page_id, v_library_id, v_op);
    ELSE
      RAISE EXCEPTION 'canvas.invalid_op: unknown kind %', v_op_kind
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_block_count FROM public.page_blocks WHERE page_id = p_page_id;
  IF v_block_count > 200 THEN
    RAISE EXCEPTION 'canvas.block_count_exceeded: page would have % blocks (max 200)', v_block_count
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.pages
     SET version = version + 1,
         wysiwyg_locked = true,
         updated_at = now()
   WHERE id = p_page_id;

  RETURN jsonb_build_object('newVersion', v_actual_version + 1, 'warnings', v_warnings);
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_apply_ops(uuid, integer, text, uuid, jsonb) TO service_role, authenticated;
