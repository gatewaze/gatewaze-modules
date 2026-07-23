-- ============================================================================
-- Module: broadcasts
-- Migration: 016_broadcast_blocks
-- Description: Block-based body for a broadcast (per spec-broadcasts-blocks.md
-- §5.3). A broadcast's content becomes an ordered list of block INSTANCES that
-- reference git-managed template definitions (templates_block_defs) — the same
-- system newsletters use (newsletters_edition_blocks), not a separate registry.
-- Rendering these ordered instances (+ their defs) produces broadcasts.rendered_html
-- (send/drip path unchanged). Optional bricks mirror newsletters_edition_bricks
-- for defs that declare has_bricks.
--
-- content_json on broadcasts is repurposed to a round-trip pointer
-- { version: 2, block_ids: [...] }; legacy { html } broadcasts keep working and
-- are surfaced as a single core 'richtext' block by the builder (§4.5). This
-- migration is additive — untouched legacy broadcasts send from their existing
-- rendered_html unchanged.
-- ============================================================================

-- Block instances -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broadcast_blocks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id           uuid NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  -- The git-managed def this instance renders from. ON DELETE SET NULL so a
  -- pruned/superseded def leaves the instance orphaned (rendered empty-safe),
  -- never cascade-deletes authored content.
  templates_block_def_id uuid REFERENCES public.templates_block_defs(id) ON DELETE SET NULL,
  -- Def key / coarse type, denormalized for stats roll-up + empty-safe render
  -- when the def is gone (e.g. 'video', 'content_section', 'event', 'richtext').
  block_type             text NOT NULL,
  -- Owning module (denormalized from the def) for gating + telemetry; NULL = core.
  owner_module           text,
  sort_order             integer NOT NULL DEFAULT 0,
  -- Optional stable slot key for recurring-block stats grouping (mirrors
  -- newsletters_edition_blocks.tracking_slug); rollups group by
  -- COALESCE(tracking_slug, block_type).
  tracking_slug          text,
  content                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcast_blocks_broadcast
  ON public.broadcast_blocks (broadcast_id, sort_order);

CREATE TRIGGER broadcast_blocks_updated_at
  BEFORE UPDATE ON public.broadcast_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.broadcast_blocks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_blocks' AND policyname = 'auth_all_broadcast_blocks') THEN
    CREATE POLICY "auth_all_broadcast_blocks" ON public.broadcast_blocks FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.broadcast_blocks IS
  'Ordered block instances forming a broadcast body; each references a git-managed templates_block_defs row (like newsletters_edition_blocks). Rendered → broadcasts.rendered_html. Per spec-broadcasts-blocks §5.3.';

-- Optional bricks (sub-blocks) for defs with has_bricks -----------------------
CREATE TABLE IF NOT EXISTS public.broadcast_bricks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id               uuid NOT NULL REFERENCES public.broadcast_blocks(id) ON DELETE CASCADE,
  templates_brick_def_id uuid REFERENCES public.templates_brick_defs(id) ON DELETE SET NULL,
  brick_type             text NOT NULL,
  sort_order             integer NOT NULL DEFAULT 0,
  content                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcast_bricks_block
  ON public.broadcast_bricks (block_id, sort_order);

CREATE TRIGGER broadcast_bricks_updated_at
  BEFORE UPDATE ON public.broadcast_bricks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.broadcast_bricks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_bricks' AND policyname = 'auth_all_broadcast_bricks') THEN
    CREATE POLICY "auth_all_broadcast_bricks" ON public.broadcast_bricks FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.broadcast_bricks IS
  'Sub-blocks of a broadcast_block, for defs that declare has_bricks (mirrors newsletters_edition_bricks).';
