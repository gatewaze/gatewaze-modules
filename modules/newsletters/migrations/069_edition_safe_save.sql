-- ============================================================================
-- Module: newsletters
-- Migration: 068_edition_safe_save
-- Description: Safe, concurrency-controlled saving of newsletter editions.
--
-- Replaces the editor's destructive "delete every block, re-insert the canvas"
-- save (admin/pages/editions/[id].tsx) — which was non-atomic (a mid-save
-- failure lost blocks), had no concurrency control (a stale tab / second
-- session / any writer silently clobbered newer content — the lost-update that
-- wiped edition 21afd12a on 2026-07-13), and kept no history.
--
-- Adds:
--   1. editions.version           — optimistic-lock counter.
--   2. blocks/bricks.deleted_at    — soft-delete (removed blocks are retained,
--                                    not hard-deleted).
--   3. newsletters_edition_revisions — append-only full snapshot per save (the
--                                    recovery net; one-click restore).
--   4. newsletters_save_edition()  — one atomic RPC: version-check → snapshot →
--                                    diff-upsert blocks/bricks → soft-delete
--                                    removed → bump version. Rejects a stale
--                                    save with a 'version_conflict' error the
--                                    client turns into a reload prompt.
--   5. newsletters_restore_edition_revision() — restore a prior snapshot.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================================

-- 1. Optimistic-lock counter -------------------------------------------------
ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.newsletters_editions.version IS
  'Optimistic-lock counter. Bumped by newsletters_save_edition; a save whose expected version != this is rejected (version_conflict).';

-- 2. Soft-delete ------------------------------------------------------------
ALTER TABLE public.newsletters_edition_blocks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.newsletters_edition_bricks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Active-block lookups (editor load, render) hit this partial index.
CREATE INDEX IF NOT EXISTS idx_newsletters_edition_blocks_active
  ON public.newsletters_edition_blocks (edition_id, sort_order) WHERE deleted_at IS NULL;

-- 3. Revision snapshots ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.newsletters_edition_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id  uuid NOT NULL REFERENCES public.newsletters_editions (id) ON DELETE CASCADE,
  revision    integer NOT NULL,             -- the edition.version this snapshot captured
  blocks      jsonb NOT NULL,               -- full block+brick set at snapshot time
  block_count integer NOT NULL DEFAULT 0,
  reason      text,                         -- 'pre-save' | 'pre-restore' | ...
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_newsletters_edition_revisions_edition
  ON public.newsletters_edition_revisions (edition_id, created_at DESC);

ALTER TABLE public.newsletters_edition_revisions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='newsletters_edition_revisions' AND policyname='newsletters_edition_revisions_select') THEN
    CREATE POLICY "newsletters_edition_revisions_select" ON public.newsletters_edition_revisions
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Snapshot the current active block+brick set of an edition into a revision row.
CREATE OR REPLACE FUNCTION public._newsletters_snapshot_edition(p_edition_id uuid, p_revision integer, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_blocks jsonb; v_count integer;
BEGIN
  SELECT coalesce(jsonb_agg(blk ORDER BY blk_sort), '[]'::jsonb), count(*)
    INTO v_blocks, v_count
  FROM (
    SELECT b.sort_order AS blk_sort,
      jsonb_build_object(
        'id', b.id, 'block_type', b.block_type, 'templates_block_def_id', b.templates_block_def_id,
        'content', b.content, 'sort_order', b.sort_order,
        'bricks', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
                   'id', k.id, 'brick_type', k.brick_type, 'templates_brick_def_id', k.templates_brick_def_id,
                   'content', k.content, 'sort_order', k.sort_order) ORDER BY k.sort_order)
          FROM public.newsletters_edition_bricks k
          WHERE k.block_id = b.id AND k.deleted_at IS NULL), '[]'::jsonb)
      ) AS blk
    FROM public.newsletters_edition_blocks b
    WHERE b.edition_id = p_edition_id AND b.deleted_at IS NULL
  ) s;

  -- Only snapshot when there's something to preserve.
  IF v_count > 0 THEN
    INSERT INTO public.newsletters_edition_revisions (edition_id, revision, blocks, block_count, reason, created_by)
    VALUES (p_edition_id, p_revision, v_blocks, v_count, p_reason, auth.uid());
  END IF;
END $$;

-- Apply a block set to an edition: diff-upsert present rows, soft-delete the
-- rest. Does NOT touch version/snapshot — callers wrap it.
CREATE OR REPLACE FUNCTION public._newsletters_apply_blocks(p_edition_id uuid, p_blocks jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Upsert blocks (un-delete on re-add).
  INSERT INTO public.newsletters_edition_blocks
    (id, edition_id, block_type, templates_block_def_id, content, sort_order, block_order, deleted_at, updated_at)
  SELECT (b->>'id')::uuid, p_edition_id, b->>'block_type',
         nullif(b->>'templates_block_def_id','')::uuid,
         coalesce(b->'content','{}'::jsonb), coalesce((b->>'sort_order')::int, 0),
         coalesce((b->>'sort_order')::int, 0), NULL, now()
  FROM jsonb_array_elements(p_blocks) b
  ON CONFLICT (id) DO UPDATE SET
    block_type = excluded.block_type, templates_block_def_id = excluded.templates_block_def_id,
    content = excluded.content, sort_order = excluded.sort_order,
    deleted_at = NULL, updated_at = now();

  -- Soft-delete blocks no longer present.
  UPDATE public.newsletters_edition_blocks
    SET deleted_at = now(), updated_at = now()
  WHERE edition_id = p_edition_id AND deleted_at IS NULL
    AND id <> ALL (COALESCE((SELECT array_agg((b->>'id')::uuid) FROM jsonb_array_elements(p_blocks) b), ARRAY[]::uuid[]));

  -- Upsert bricks (flattened from each block).
  INSERT INTO public.newsletters_edition_bricks
    (id, block_id, brick_type, templates_brick_def_id, content, sort_order, brick_order, deleted_at, updated_at)
  SELECT (br->>'id')::uuid, (b->>'id')::uuid, br->>'brick_type',
         nullif(br->>'templates_brick_def_id','')::uuid,
         coalesce(br->'content','{}'::jsonb), coalesce((br->>'sort_order')::int, 0),
         coalesce((br->>'sort_order')::int, 0), NULL, now()
  FROM jsonb_array_elements(p_blocks) b,
       jsonb_array_elements(coalesce(b->'bricks','[]'::jsonb)) br
  ON CONFLICT (id) DO UPDATE SET
    block_id = excluded.block_id, brick_type = excluded.brick_type,
    templates_brick_def_id = excluded.templates_brick_def_id,
    content = excluded.content, sort_order = excluded.sort_order,
    deleted_at = NULL, updated_at = now();

  -- Soft-delete bricks no longer present (across this edition's blocks).
  UPDATE public.newsletters_edition_bricks k
    SET deleted_at = now(), updated_at = now()
  WHERE k.deleted_at IS NULL
    AND k.block_id IN (SELECT id FROM public.newsletters_edition_blocks WHERE edition_id = p_edition_id)
    AND k.id <> ALL (COALESCE((
      SELECT array_agg((br->>'id')::uuid)
      FROM jsonb_array_elements(p_blocks) b, jsonb_array_elements(coalesce(b->'bricks','[]'::jsonb)) br
    ), ARRAY[]::uuid[]));
END $$;

-- 4. Atomic save with optimistic locking ------------------------------------
-- p_expected_version: the version the client loaded. NULL skips the check
-- (first save / non-concurrent callers). p_title/p_preheader/p_content_category
-- NULL = leave unchanged. p_blocks: array of
--   {id, block_type, templates_block_def_id, content, sort_order, bricks:[...]}.
-- Returns { version, revision, conflict:false }. On a stale version raises
-- 'version_conflict' (SQLSTATE 55006) so PostgREST returns an error the client
-- detects and turns into a reload prompt — the save is NOT applied.
CREATE OR REPLACE FUNCTION public.newsletters_save_edition(
  p_edition_id uuid,
  p_expected_version integer,
  p_title text,
  p_preheader text,
  p_content_category text,
  p_edition_date date,
  p_blocks jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cur integer; v_new integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorised to save this edition' USING ERRCODE = '42501';
  END IF;

  SELECT version INTO v_cur FROM public.newsletters_editions WHERE id = p_edition_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition % not found', p_edition_id USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_version IS NOT NULL AND v_cur <> p_expected_version THEN
    RAISE EXCEPTION 'version_conflict: edition changed since load (expected %, now %)', p_expected_version, v_cur
      USING ERRCODE = '55006';   -- object_not_in_prerequisite_state
  END IF;

  PERFORM public._newsletters_snapshot_edition(p_edition_id, v_cur, 'pre-save');
  PERFORM public._newsletters_apply_blocks(p_edition_id, coalesce(p_blocks, '[]'::jsonb));

  v_new := v_cur + 1;
  UPDATE public.newsletters_editions SET
    title = coalesce(p_title, title),
    preheader = coalesce(p_preheader, preheader),
    content_category = coalesce(p_content_category, content_category),
    edition_date = coalesce(p_edition_date, edition_date),
    version = v_new,
    updated_at = now()
  WHERE id = p_edition_id;

  RETURN jsonb_build_object('version', v_new, 'revision', v_cur, 'conflict', false);
END $$;

-- 5. Restore a prior revision ------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_restore_edition_revision(
  p_edition_id uuid,
  p_revision integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_blocks jsonb; v_cur integer; v_new integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT blocks INTO v_blocks FROM public.newsletters_edition_revisions
    WHERE edition_id = p_edition_id AND revision = p_revision
    ORDER BY created_at DESC LIMIT 1;
  IF v_blocks IS NULL THEN
    RAISE EXCEPTION 'revision % not found for edition %', p_revision, p_edition_id USING ERRCODE = 'P0002';
  END IF;

  SELECT version INTO v_cur FROM public.newsletters_editions WHERE id = p_edition_id FOR UPDATE;
  PERFORM public._newsletters_snapshot_edition(p_edition_id, v_cur, 'pre-restore');
  PERFORM public._newsletters_apply_blocks(p_edition_id, v_blocks);

  v_new := v_cur + 1;
  UPDATE public.newsletters_editions SET version = v_new, updated_at = now() WHERE id = p_edition_id;
  RETURN jsonb_build_object('version', v_new, 'restored_from', p_revision, 'blocks', jsonb_array_length(v_blocks));
END $$;

REVOKE ALL ON FUNCTION public.newsletters_save_edition(uuid, integer, text, text, text, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_restore_edition_revision(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletters_save_edition(uuid, integer, text, text, text, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.newsletters_restore_edition_revision(uuid, integer) TO authenticated;
