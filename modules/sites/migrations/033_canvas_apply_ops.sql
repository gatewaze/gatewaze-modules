-- ============================================================================
-- Migration: sites_033_canvas_apply_ops
-- Description: Phase 1.B — transactional op-application for the canvas.
--
--   - canvas_idempotency table — caches the response payload per
--     (page_id, idempotency_key). Replays original response on duplicate
--     POST. Per spec-sites-wysiwyg-builder §6.1.
--
--   - canvas_apply_ops(p_page_id, p_base_version, p_client_token,
--                      p_editor_id, p_ops) RETURNS jsonb
--     PL/pgSQL function that applies an op-batch atomically:
--       - SELECT … FOR UPDATE NOWAIT on pages (fail fast on contention)
--       - Validate base_version + lock ownership
--       - Apply each op in order
--       - Bump pages.version + flip wysiwyg_locked
--       - Return new version + warnings
--     All-or-nothing — any op failure aborts the transaction.
--
--     Sort-order gap-and-renumber per spec §5.4: insert/move calculates
--     midpoint within the cohort (page_id, parent_brick_id); when gap < 2
--     the cohort is renumbered (each row gets ROW_NUMBER * 1000) before
--     the actual insert. Renumber touches at most CANVAS_BLOCK_COUNT_MAX
--     rows (200 per spec §8).
--
-- Idempotent.
-- ============================================================================

-- ==========================================================================
-- 1. canvas_idempotency table
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.canvas_idempotency (
  page_id          uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  idempotency_key  uuid NOT NULL,
  response         jsonb NOT NULL,
  http_status      int NOT NULL DEFAULT 200,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  PRIMARY KEY (page_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canvas_idempotency_expires_idx
  ON public.canvas_idempotency (expires_at);

COMMENT ON TABLE public.canvas_idempotency IS
  'Per spec-sites-wysiwyg-builder §6.1: caches the full ApplyOpsResponse for 1 hour after the original request. A duplicate POST with the same Idempotency-Key replays the cached response (with original status) without re-applying ops.';

-- Sweep helper, called by the API server on a 5-minute timer (or pg_cron
-- if available). Idempotent.
CREATE OR REPLACE FUNCTION public.canvas_idempotency_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.canvas_idempotency WHERE expires_at < now();
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_idempotency_sweep() TO service_role;

-- ==========================================================================
-- 2. Helper: cohort key match
-- ==========================================================================
-- Two sort_order rows are in the same cohort iff they share (page_id,
-- parent_brick_id IS NOT DISTINCT FROM …). NULL = top-level cohort.
-- Used inside canvas_apply_ops; not exposed as an RPC.

-- ==========================================================================
-- 3. canvas_apply_ops — the main transactional applier
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
  -- 1. Acquire row lock + version check (fail-fast).
  BEGIN
    SELECT version, l.editor_id, l.client_token, s.templates_library_id
      INTO v_actual_version, v_lock_editor, v_lock_token, v_library_id
      FROM public.pages p
      JOIN public.sites s ON s.id = p.site_id
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
      'code', 'not_found',
      'message', 'page not found'
    ));
  END IF;

  IF v_actual_version <> p_base_version THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'canvas.version_conflict',
      'actualVersion', v_actual_version
    ));
  END IF;

  -- 2. Verify caller holds the lock.
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

  -- 3. Apply each op.
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
    ELSIF v_op_kind = 'brick.insert' THEN
      PERFORM public._canvas_apply_brick_insert(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.move' THEN
      PERFORM public._canvas_apply_brick_move(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.delete' THEN
      PERFORM public._canvas_apply_brick_delete(p_page_id, v_op);
    ELSIF v_op_kind = 'brick.update_field' THEN
      PERFORM public._canvas_apply_brick_update_field(p_page_id, v_op);
    ELSIF v_op_kind = 'preset.apply' THEN
      PERFORM public._canvas_apply_preset(p_page_id, v_library_id, v_op);
    ELSE
      RAISE EXCEPTION 'canvas.invalid_op: unknown kind %', v_op_kind
        USING ERRCODE = '22023';  -- invalid_parameter_value
    END IF;
  END LOOP;

  -- 4. Block-count cap (per spec §8).
  SELECT count(*) INTO v_block_count FROM public.page_blocks WHERE page_id = p_page_id;
  IF v_block_count > 200 THEN
    RAISE EXCEPTION 'canvas.block_count_exceeded: page would have % blocks (max 200)', v_block_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5. Bump version + flip wysiwyg_locked.
  UPDATE public.pages
     SET version = version + 1,
         wysiwyg_locked = true,
         updated_at = now()
   WHERE id = p_page_id;

  RETURN jsonb_build_object(
    'newVersion', v_actual_version + 1,
    'warnings', v_warnings
  );
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_apply_ops(uuid, integer, text, uuid, jsonb)
  TO service_role;

-- ==========================================================================
-- 4. Per-op private helpers
-- ==========================================================================
-- Each helper applies a single op. Underscore-prefixed = "private";
-- not granted to authenticated/anon, only the dispatcher invokes them.

-- 4.a block.insert
CREATE OR REPLACE FUNCTION public._canvas_apply_block_insert(
  p_page_id    uuid,
  p_library_id uuid,
  p_op         jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_def_id     uuid;
  v_block_def_valid  boolean;
  v_after_block_id   uuid;
  v_parent_brick_id  uuid;
  v_after_sort       bigint;
  v_next_sort        bigint;
  v_new_sort         bigint;
  v_new_block_id     uuid;
  v_block_def_key    text;
BEGIN
  v_block_def_key   := p_op->>'blockDefKey';
  v_after_block_id  := NULLIF(p_op->>'afterBlockId', '')::uuid;
  v_parent_brick_id := NULLIF(p_op->>'parentBrickId', '')::uuid;

  -- Resolve block_def by key within the site's library; require canvas-validated.
  SELECT id, COALESCE(canvas_validated, false)
    INTO v_block_def_id, v_block_def_valid
    FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = v_block_def_key AND is_current = true
   LIMIT 1;

  IF v_block_def_id IS NULL THEN
    RAISE EXCEPTION 'canvas.block_def_not_found: no block_def with key=% in library', v_block_def_key
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_block_def_valid THEN
    RAISE EXCEPTION 'canvas.block_def_not_validated: block_def % failed canvas template validation', v_block_def_key
      USING ERRCODE = '23514';
  END IF;

  -- Compute sort_order via gap-and-renumber within the cohort.
  v_new_sort := public._canvas_next_sort_order(p_page_id, v_parent_brick_id, v_after_block_id);

  INSERT INTO public.page_blocks
    (page_id, block_def_id, parent_brick_id, sort_order, content, variant_key)
  VALUES
    (p_page_id, v_block_def_id, v_parent_brick_id, v_new_sort,
     COALESCE(p_op->'content', '{}'::jsonb), 'default')
  RETURNING id INTO v_new_block_id;

  RETURN v_new_block_id;
END $$;

-- 4.b block.move
CREATE OR REPLACE FUNCTION public._canvas_apply_block_move(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_id        uuid;
  v_after_block_id  uuid;
  v_parent_brick_id uuid;
  v_new_sort        bigint;
  v_block_page_id   uuid;
BEGIN
  v_block_id        := (p_op->>'blockId')::uuid;
  v_after_block_id  := NULLIF(p_op->>'afterBlockId', '')::uuid;
  v_parent_brick_id := NULLIF(p_op->>'parentBrickId', '')::uuid;

  SELECT page_id INTO v_block_page_id FROM public.page_blocks WHERE id = v_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: block % does not belong to page %', v_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  v_new_sort := public._canvas_next_sort_order(p_page_id, v_parent_brick_id, v_after_block_id);

  UPDATE public.page_blocks
     SET parent_brick_id = v_parent_brick_id,
         sort_order      = v_new_sort,
         updated_at      = now()
   WHERE id = v_block_id;
END $$;

-- 4.c block.delete
CREATE OR REPLACE FUNCTION public._canvas_apply_block_delete(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_id      uuid;
  v_block_page_id uuid;
BEGIN
  v_block_id := (p_op->>'blockId')::uuid;
  SELECT page_id INTO v_block_page_id FROM public.page_blocks WHERE id = v_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: block % does not belong to page %', v_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;
  -- ON DELETE CASCADE on page_block_bricks handles children.
  DELETE FROM public.page_blocks WHERE id = v_block_id;
END $$;

-- 4.d block.update_field
-- Walks the existing content jsonb and replaces the value at fieldPath.
-- Path syntax matches canvas-render/jsonpath.ts: dot-separated props +
-- bracket indices. Example: "image.alt", "list[0].title".
CREATE OR REPLACE FUNCTION public._canvas_apply_block_update_field(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_id      uuid;
  v_field_path    text;
  v_new_value     jsonb;
  v_block_page_id uuid;
  v_path          text[];
BEGIN
  v_block_id   := (p_op->>'blockId')::uuid;
  v_field_path := p_op->>'fieldPath';
  v_new_value  := p_op->'newValue';

  SELECT page_id INTO v_block_page_id FROM public.page_blocks WHERE id = v_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: block % does not belong to page %', v_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  v_path := public._canvas_parse_jsonpath(v_field_path);

  UPDATE public.page_blocks
     SET content    = jsonb_set(content, v_path, v_new_value, true),
         updated_at = now()
   WHERE id = v_block_id;
END $$;

-- 4.e block.set_variant
CREATE OR REPLACE FUNCTION public._canvas_apply_block_set_variant(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_block_id      uuid;
  v_variant_key   text;
  v_block_page_id uuid;
BEGIN
  v_block_id    := (p_op->>'blockId')::uuid;
  v_variant_key := p_op->>'variantKey';

  SELECT page_id INTO v_block_page_id FROM public.page_blocks WHERE id = v_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: block % does not belong to page %', v_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.page_blocks
     SET variant_key = v_variant_key,
         updated_at  = now()
   WHERE id = v_block_id;
END $$;

-- 4.f brick.insert
CREATE OR REPLACE FUNCTION public._canvas_apply_brick_insert(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_page_block_id     uuid;
  v_brick_def_key     text;
  v_after_brick_id    uuid;
  v_brick_def_id      uuid;
  v_block_def_id      uuid;
  v_new_brick_id      uuid;
  v_new_sort          bigint;
  v_block_page_id     uuid;
BEGIN
  v_page_block_id  := (p_op->>'pageBlockId')::uuid;
  v_brick_def_key  := p_op->>'brickDefKey';
  v_after_brick_id := NULLIF(p_op->>'afterBrickId', '')::uuid;

  SELECT page_id, block_def_id INTO v_block_page_id, v_block_def_id
    FROM public.page_blocks WHERE id = v_page_block_id;
  IF v_block_page_id IS NULL OR v_block_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: page_block % does not belong to page %', v_page_block_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  -- Resolve brick_def by (block_def_id, key).
  SELECT id INTO v_brick_def_id
    FROM public.templates_brick_defs
   WHERE block_def_id = v_block_def_id AND key = v_brick_def_key
   LIMIT 1;
  IF v_brick_def_id IS NULL THEN
    RAISE EXCEPTION 'canvas.brick_def_not_found: no brick_def with key=% under block_def %', v_brick_def_key, v_block_def_id
      USING ERRCODE = '23503';
  END IF;

  v_new_sort := public._canvas_next_brick_sort_order(v_page_block_id, v_after_brick_id);

  INSERT INTO public.page_block_bricks
    (page_block_id, brick_def_id, sort_order, content, variant_key)
  VALUES
    (v_page_block_id, v_brick_def_id, v_new_sort,
     COALESCE(p_op->'content', '{}'::jsonb), 'default')
  RETURNING id INTO v_new_brick_id;

  RETURN v_new_brick_id;
END $$;

-- 4.g brick.move
CREATE OR REPLACE FUNCTION public._canvas_apply_brick_move(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_brick_id        uuid;
  v_after_brick_id  uuid;
  v_page_block_id   uuid;
  v_new_sort        bigint;
  v_owner_page_id   uuid;
BEGIN
  v_brick_id       := (p_op->>'brickId')::uuid;
  v_after_brick_id := NULLIF(p_op->>'afterBrickId', '')::uuid;

  SELECT bk.page_block_id, pb.page_id INTO v_page_block_id, v_owner_page_id
    FROM public.page_block_bricks bk
    JOIN public.page_blocks pb ON pb.id = bk.page_block_id
   WHERE bk.id = v_brick_id;
  IF v_owner_page_id IS NULL OR v_owner_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: brick % does not belong to page %', v_brick_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  v_new_sort := public._canvas_next_brick_sort_order(v_page_block_id, v_after_brick_id);

  UPDATE public.page_block_bricks
     SET sort_order = v_new_sort,
         updated_at = now()
   WHERE id = v_brick_id;
END $$;

-- 4.h brick.delete
CREATE OR REPLACE FUNCTION public._canvas_apply_brick_delete(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_brick_id      uuid;
  v_owner_page_id uuid;
BEGIN
  v_brick_id := (p_op->>'brickId')::uuid;
  SELECT pb.page_id INTO v_owner_page_id
    FROM public.page_block_bricks bk
    JOIN public.page_blocks pb ON pb.id = bk.page_block_id
   WHERE bk.id = v_brick_id;
  IF v_owner_page_id IS NULL OR v_owner_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: brick % does not belong to page %', v_brick_id, p_page_id
      USING ERRCODE = '23503';
  END IF;
  DELETE FROM public.page_block_bricks WHERE id = v_brick_id;
END $$;

-- 4.i brick.update_field
CREATE OR REPLACE FUNCTION public._canvas_apply_brick_update_field(
  p_page_id uuid,
  p_op      jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_brick_id      uuid;
  v_field_path    text;
  v_new_value     jsonb;
  v_owner_page_id uuid;
  v_path          text[];
BEGIN
  v_brick_id   := (p_op->>'brickId')::uuid;
  v_field_path := p_op->>'fieldPath';
  v_new_value  := p_op->'newValue';

  SELECT pb.page_id INTO v_owner_page_id
    FROM public.page_block_bricks bk
    JOIN public.page_blocks pb ON pb.id = bk.page_block_id
   WHERE bk.id = v_brick_id;
  IF v_owner_page_id IS NULL OR v_owner_page_id <> p_page_id THEN
    RAISE EXCEPTION 'canvas.dangling_ref: brick % does not belong to page %', v_brick_id, p_page_id
      USING ERRCODE = '23503';
  END IF;

  v_path := public._canvas_parse_jsonpath(v_field_path);

  UPDATE public.page_block_bricks
     SET content    = jsonb_set(content, v_path, v_new_value, true),
         updated_at = now()
   WHERE id = v_brick_id;
END $$;

-- 4.j preset.apply
-- Reads the preset payload, validates the block_def + brick_defs still
-- exist + are canvas_validated, then INSERTs the block + bricks.
CREATE OR REPLACE FUNCTION public._canvas_apply_preset(
  p_page_id    uuid,
  p_library_id uuid,
  p_op         jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_preset_id        uuid;
  v_preset_payload   jsonb;
  v_preset_site_id   uuid;
  v_after_block_id   uuid;
  v_parent_brick_id  uuid;
  v_block_def_key    text;
  v_block_def_id     uuid;
  v_block_def_valid  boolean;
  v_new_block_id     uuid;
  v_new_sort         bigint;
  v_brick            jsonb;
  v_brick_def_id     uuid;
  v_brick_sort       bigint := 1000;
  v_page_site_id     uuid;
BEGIN
  v_preset_id       := (p_op->>'presetId')::uuid;
  v_after_block_id  := NULLIF(p_op->>'afterBlockId', '')::uuid;
  v_parent_brick_id := NULLIF(p_op->>'parentBrickId', '')::uuid;

  SELECT site_id, payload INTO v_preset_site_id, v_preset_payload
    FROM public.page_block_presets
   WHERE id = v_preset_id;
  IF v_preset_payload IS NULL THEN
    RAISE EXCEPTION 'canvas.preset_not_found: preset %', v_preset_id
      USING ERRCODE = '23503';
  END IF;

  -- Confirm preset belongs to the same site as the page.
  SELECT site_id INTO v_page_site_id FROM public.pages WHERE id = p_page_id;
  IF v_page_site_id IS DISTINCT FROM v_preset_site_id THEN
    RAISE EXCEPTION 'canvas.preset_wrong_site: preset is for a different site'
      USING ERRCODE = 'check_violation';
  END IF;

  v_block_def_key := v_preset_payload->>'block_def_key';
  SELECT id, COALESCE(canvas_validated, false)
    INTO v_block_def_id, v_block_def_valid
    FROM public.templates_block_defs
   WHERE library_id = p_library_id AND key = v_block_def_key AND is_current = true
   LIMIT 1;
  IF v_block_def_id IS NULL OR NOT v_block_def_valid THEN
    RAISE EXCEPTION 'canvas.preset_block_def_invalid: block_def % missing or unvalidated', v_block_def_key
      USING ERRCODE = '23503';
  END IF;

  v_new_sort := public._canvas_next_sort_order(p_page_id, v_parent_brick_id, v_after_block_id);

  INSERT INTO public.page_blocks
    (page_id, block_def_id, parent_brick_id, sort_order, content, variant_key)
  VALUES
    (p_page_id, v_block_def_id, v_parent_brick_id, v_new_sort,
     COALESCE(v_preset_payload->'content', '{}'::jsonb), 'default')
  RETURNING id INTO v_new_block_id;

  -- Insert bricks from the preset.
  FOR v_brick IN SELECT * FROM jsonb_array_elements(COALESCE(v_preset_payload->'bricks', '[]'::jsonb)) LOOP
    SELECT id INTO v_brick_def_id
      FROM public.templates_brick_defs
     WHERE block_def_id = v_block_def_id AND key = (v_brick->>'brick_def_key')
     LIMIT 1;
    IF v_brick_def_id IS NULL THEN
      RAISE EXCEPTION 'canvas.preset_brick_def_invalid: brick_def % missing under block_def %',
        v_brick->>'brick_def_key', v_block_def_key
        USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.page_block_bricks
      (page_block_id, brick_def_id, sort_order, content, variant_key)
    VALUES
      (v_new_block_id, v_brick_def_id, v_brick_sort,
       COALESCE(v_brick->'content', '{}'::jsonb), 'default');
    v_brick_sort := v_brick_sort + 1000;
  END LOOP;

  RETURN v_new_block_id;
END $$;

-- ==========================================================================
-- 5. Sort-order gap-and-renumber helpers
-- ==========================================================================

CREATE OR REPLACE FUNCTION public._canvas_next_sort_order(
  p_page_id          uuid,
  p_parent_brick_id  uuid,
  p_after_block_id   uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_after_sort  bigint;
  v_next_sort   bigint;
  v_min_sort    bigint;
BEGIN
  IF p_after_block_id IS NULL THEN
    -- Insert at start of cohort.
    SELECT MIN(sort_order) INTO v_min_sort
      FROM public.page_blocks
     WHERE page_id = p_page_id AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id;
    IF v_min_sort IS NULL THEN
      RETURN 1000;  -- empty cohort
    END IF;
    IF v_min_sort > 1 THEN
      RETURN v_min_sort - 1000;
    END IF;
    -- Cohort starts near zero; renumber + retry.
    PERFORM public._canvas_renumber_block_cohort(p_page_id, p_parent_brick_id);
    SELECT MIN(sort_order) INTO v_min_sort
      FROM public.page_blocks
     WHERE page_id = p_page_id AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id;
    RETURN GREATEST(1, v_min_sort - 1000);
  END IF;

  -- Insert after a specific block. Verify it exists in the same cohort.
  SELECT sort_order INTO v_after_sort
    FROM public.page_blocks
   WHERE id = p_after_block_id
     AND page_id = p_page_id
     AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id;
  IF v_after_sort IS NULL THEN
    RAISE EXCEPTION 'canvas.dangling_ref: afterBlockId % not in target cohort', p_after_block_id
      USING ERRCODE = '23503';
  END IF;

  -- Find the next block in the cohort (greater sort_order).
  SELECT MIN(sort_order) INTO v_next_sort
    FROM public.page_blocks
   WHERE page_id = p_page_id
     AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id
     AND sort_order > v_after_sort;

  IF v_next_sort IS NULL THEN
    RETURN v_after_sort + 1000;  -- insert at end
  END IF;

  IF v_next_sort - v_after_sort < 2 THEN
    -- No gap; renumber the cohort then retry.
    PERFORM public._canvas_renumber_block_cohort(p_page_id, p_parent_brick_id);
    SELECT sort_order INTO v_after_sort
      FROM public.page_blocks
     WHERE id = p_after_block_id;
    SELECT MIN(sort_order) INTO v_next_sort
      FROM public.page_blocks
     WHERE page_id = p_page_id
       AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id
       AND sort_order > v_after_sort;
    IF v_next_sort IS NULL THEN
      RETURN v_after_sort + 1000;
    END IF;
  END IF;

  RETURN (v_after_sort + v_next_sort) / 2;
END $$;

CREATE OR REPLACE FUNCTION public._canvas_renumber_block_cohort(
  p_page_id          uuid,
  p_parent_brick_id  uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.page_blocks pb
     SET sort_order = sub.new_order * 1000
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) AS new_order
        FROM public.page_blocks
       WHERE page_id = p_page_id AND parent_brick_id IS NOT DISTINCT FROM p_parent_brick_id
    ) sub
   WHERE pb.id = sub.id;
END $$;

CREATE OR REPLACE FUNCTION public._canvas_next_brick_sort_order(
  p_page_block_id    uuid,
  p_after_brick_id   uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_after_sort bigint;
  v_next_sort  bigint;
  v_min_sort   bigint;
BEGIN
  IF p_after_brick_id IS NULL THEN
    SELECT MIN(sort_order) INTO v_min_sort
      FROM public.page_block_bricks
     WHERE page_block_id = p_page_block_id;
    IF v_min_sort IS NULL THEN RETURN 1000; END IF;
    IF v_min_sort > 1 THEN RETURN v_min_sort - 1000; END IF;
    PERFORM public._canvas_renumber_brick_cohort(p_page_block_id);
    SELECT MIN(sort_order) INTO v_min_sort
      FROM public.page_block_bricks
     WHERE page_block_id = p_page_block_id;
    RETURN GREATEST(1, v_min_sort - 1000);
  END IF;

  SELECT sort_order INTO v_after_sort
    FROM public.page_block_bricks
   WHERE id = p_after_brick_id AND page_block_id = p_page_block_id;
  IF v_after_sort IS NULL THEN
    RAISE EXCEPTION 'canvas.dangling_ref: afterBrickId % not in target block', p_after_brick_id
      USING ERRCODE = '23503';
  END IF;

  SELECT MIN(sort_order) INTO v_next_sort
    FROM public.page_block_bricks
   WHERE page_block_id = p_page_block_id AND sort_order > v_after_sort;

  IF v_next_sort IS NULL THEN
    RETURN v_after_sort + 1000;
  END IF;

  IF v_next_sort - v_after_sort < 2 THEN
    PERFORM public._canvas_renumber_brick_cohort(p_page_block_id);
    SELECT sort_order INTO v_after_sort FROM public.page_block_bricks WHERE id = p_after_brick_id;
    SELECT MIN(sort_order) INTO v_next_sort
      FROM public.page_block_bricks
     WHERE page_block_id = p_page_block_id AND sort_order > v_after_sort;
    IF v_next_sort IS NULL THEN RETURN v_after_sort + 1000; END IF;
  END IF;

  RETURN (v_after_sort + v_next_sort) / 2;
END $$;

CREATE OR REPLACE FUNCTION public._canvas_renumber_brick_cohort(
  p_page_block_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.page_block_bricks bk
     SET sort_order = sub.new_order * 1000
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) AS new_order
        FROM public.page_block_bricks
       WHERE page_block_id = p_page_block_id
    ) sub
   WHERE bk.id = sub.id;
END $$;

-- ==========================================================================
-- 6. JSONPath parser for jsonb_set
-- ==========================================================================
-- Mirrors the canvas-render/jsonpath.ts parser. Converts "image.alt" to
-- ARRAY['image','alt'] and "list[0].title" to ARRAY['list','0','title']
-- (jsonb_set treats numeric strings as array indices).

CREATE OR REPLACE FUNCTION public._canvas_parse_jsonpath(p_path text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_segs   text[] := ARRAY[]::text[];
  v_match  text[];
  v_input  text := p_path;
BEGIN
  IF p_path IS NULL OR p_path = '' THEN
    RETURN v_segs;
  END IF;

  WHILE length(v_input) > 0 LOOP
    -- Match either: bracket-index "[N]" OR identifier (letters/digits/_/-)
    -- followed by an optional dot.
    v_match := regexp_match(v_input, '^\[(\d+)\]\.?');
    IF v_match IS NOT NULL THEN
      v_segs  := v_segs || v_match[1];
      v_input := substring(v_input from char_length(v_match[1]) + 3);
      CONTINUE;
    END IF;

    v_match := regexp_match(v_input, '^([^.\[\]]+)\.?');
    IF v_match IS NOT NULL THEN
      v_segs  := v_segs || v_match[1];
      v_input := substring(v_input from char_length(v_match[1]) + 1);
      -- Skip leading dot if present.
      IF substring(v_input from 1 for 1) = '.' THEN
        v_input := substring(v_input from 2);
      END IF;
      CONTINUE;
    END IF;

    -- Unparseable; bail.
    EXIT;
  END LOOP;

  RETURN v_segs;
END $$;
