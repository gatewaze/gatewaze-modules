-- ============================================================================
-- Migration: sites_032_canvas_tables
-- Description: Phase 1 schema for the WYSIWYG canvas builder, per
--              spec-sites-wysiwyg-builder.md §4.
--
--   - page_canvas_locks       — advisory single-editor lock (§4.1)
--   - page_block_presets      — reusable per-site block compositions (§4.1)
--   - pages.wysiwyg_locked    — JSON-lock discriminator (§4.2)
--   - page_blocks.parent_brick_id   — nesting via container blocks (§4.2)
--   - page_blocks.sort_order  → bigint  (gap-and-renumber, §5.4)
--   - page_block_bricks.sort_order → bigint
--   - page_blocks_page_sort_idx  — composite index for tree retrieval
--   - trg_page_blocks_no_cycle — corrected cycle-detection trigger (§4.3)
--   - pages_content_matches_kind — relaxed for blocks-mode (§4.2)
--
-- Idempotent: each statement is gated by IF NOT EXISTS / IF EXISTS where
-- the underlying SQL supports it. The pages_content_matches_kind function
-- is replaced via CREATE OR REPLACE.
-- ============================================================================

-- ==========================================================================
-- 1. page_canvas_locks — advisory editor lock
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_canvas_locks (
  page_id        uuid PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
  editor_id      uuid NOT NULL,
  locked_at      timestamptz NOT NULL DEFAULT now(),
  heartbeat_at   timestamptz NOT NULL DEFAULT now(),
  client_token   text NOT NULL CHECK (length(client_token) BETWEEN 16 AND 64)
);

CREATE INDEX IF NOT EXISTS page_canvas_locks_heartbeat_idx
  ON public.page_canvas_locks (heartbeat_at);

-- Lazy reaper called by POST /admin/pages/:id/canvas/lock before each upsert.
-- Single SQL statement; idempotent; cheap.
CREATE OR REPLACE FUNCTION public.canvas_reap_stale_locks(p_ttl_seconds int DEFAULT 90)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.page_canvas_locks
   WHERE heartbeat_at < now() - make_interval(secs => p_ttl_seconds);
END $$;

GRANT EXECUTE ON FUNCTION public.canvas_reap_stale_locks(int) TO service_role, authenticated;

COMMENT ON TABLE public.page_canvas_locks IS
  'Advisory single-editor lock for the WYSIWYG canvas. Reaped lazy-on-acquire (90s TTL) plus a 5-minute scheduled sweep. Per spec-sites-wysiwyg-builder §4.1.';

-- ==========================================================================
-- 2. page_block_presets — reusable per-site block compositions
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_block_presets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description    text,
  preview_image  text,
  payload        jsonb NOT NULL,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

CREATE INDEX IF NOT EXISTS page_block_presets_site_idx
  ON public.page_block_presets (site_id);

COMMENT ON TABLE public.page_block_presets IS
  'Per-site reusable block compositions ("save as preset"). payload shape: { block_def_key, content, bricks: [{ brick_def_key, content }] }. Validated against block/brick schemas at save AND apply time. Per spec-sites-wysiwyg-builder §4.1.';

-- ==========================================================================
-- 3. pages.wysiwyg_locked — JSON-lock discriminator
-- ==========================================================================

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS wysiwyg_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pages.wysiwyg_locked IS
  'Per spec-sites-wysiwyg-builder §5.5: when true, the publish-worker rejects manual edits to content/pages/<slug>.json — the canvas is the only valid editor. Auto-set to true when a blocks-mode page is first saved via /admin/pages/:id/canvas.';

-- ==========================================================================
-- 4. page_blocks.parent_brick_id + sort_order bigint
-- ==========================================================================

ALTER TABLE public.page_blocks
  ADD COLUMN IF NOT EXISTS parent_brick_id uuid REFERENCES public.page_block_bricks(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.page_blocks.parent_brick_id IS
  'Per spec-sites-wysiwyg-builder §4.2: when set, this block is nested inside a parent block''s brick slot (e.g. a column of a row-2col container). NULL = top-level block. Cycles prevented by trg_page_blocks_no_cycle.';

-- sort_order: int → bigint with gap multiplier (1000) so we have room for
-- gap-and-renumber inserts. Idempotent: only widens type if currently int.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'page_blocks' AND column_name = 'sort_order' AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.page_blocks
      ALTER COLUMN sort_order TYPE bigint USING (sort_order::bigint * 1000);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'page_block_bricks' AND column_name = 'sort_order' AND data_type = 'integer'
  ) THEN
    ALTER TABLE public.page_block_bricks
      ALTER COLUMN sort_order TYPE bigint USING (sort_order::bigint * 1000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS page_blocks_parent_brick_idx
  ON public.page_blocks (parent_brick_id) WHERE parent_brick_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS page_blocks_page_sort_idx
  ON public.page_blocks (page_id, sort_order);

CREATE INDEX IF NOT EXISTS page_block_bricks_block_sort_idx
  ON public.page_block_bricks (page_block_id, sort_order);

-- ==========================================================================
-- 5. trg_page_blocks_no_cycle — corrected cycle-detection trigger
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.trg_page_blocks_no_cycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_depth        int := 0;
  v_cursor       uuid := NEW.parent_brick_id;
  v_owning_block uuid;
BEGIN
  WHILE v_cursor IS NOT NULL AND v_depth < 32 LOOP
    -- Resolve the block that OWNS this brick.
    SELECT bk.page_block_id INTO v_owning_block
      FROM public.page_block_bricks bk
     WHERE bk.id = v_cursor;
    -- If that owning block IS the row being inserted/updated → cycle.
    IF v_owning_block = NEW.id THEN
      RAISE EXCEPTION 'page_blocks_cycle: block % is reachable from its own descendants', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- Walk up: find the parent_brick_id of v_owning_block.
    SELECT pb.parent_brick_id INTO v_cursor
      FROM public.page_blocks pb
     WHERE pb.id = v_owning_block;
    v_depth := v_depth + 1;
  END LOOP;
  IF v_depth >= 32 THEN
    RAISE EXCEPTION 'page_blocks_too_deep: nesting exceeds 32 levels'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_page_blocks_no_cycle_iu ON public.page_blocks;
CREATE TRIGGER trg_page_blocks_no_cycle_iu
  BEFORE INSERT OR UPDATE OF parent_brick_id ON public.page_blocks
  FOR EACH ROW EXECUTE FUNCTION public.trg_page_blocks_no_cycle();

-- ==========================================================================
-- 6. pages_content_matches_kind — relaxed for blocks-mode
-- ==========================================================================
-- Existing trigger (sites_010) requires `content + content_schema_version`
-- on every website-kind page. Blocks-mode pages don't use those columns
-- (page_blocks rows are the source of truth). Loosen the trigger to permit
-- blocks-mode with content='{}', content_schema_version=NULL.

CREATE OR REPLACE FUNCTION public.pages_content_matches_kind()
RETURNS trigger AS $$
DECLARE
  v_site_kind text;
  v_mode      text;
BEGIN
  IF NEW.host_kind = 'site' AND NEW.host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = NEW.host_id;
    -- composition_mode comes from the row itself (added in sites_012).
    v_mode := NEW.composition_mode;

    IF v_site_kind = 'website' AND v_mode = 'schema' THEN
      IF NEW.content IS NULL OR NEW.content_schema_version IS NULL THEN
        RAISE EXCEPTION 'invalid_pages_content_for_theme_kind: website + schema requires content AND content_schema_version'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF v_site_kind = 'website' AND v_mode = 'blocks' THEN
      -- Allow content='{}', content_schema_version=NULL. Reject anything
      -- else so editors don't accidentally store schema-shaped content on
      -- a blocks page.
      IF NEW.content IS NOT NULL AND NEW.content <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid_pages_content_for_blocks_mode: content must be empty object on composition_mode=blocks'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.content_schema_version IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_pages_content_for_blocks_mode: content_schema_version must be NULL on composition_mode=blocks'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
