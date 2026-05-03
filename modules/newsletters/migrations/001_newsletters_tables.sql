-- ============================================================================
-- Module: newsletters
-- Migration: 001_newsletters_tables
-- Description: Create newsletter tables for edition management and link tracking
-- ============================================================================

-- Newsletters (synced editions from external sources like Substack/Beehiiv)
CREATE TABLE IF NOT EXISTS public.newsletters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           varchar(500) NOT NULL,
  description     text,
  url             text,
  image_url       text,
  date            date NOT NULL,
  published       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletters IS 'Newsletter editions synced from external platforms';

CREATE INDEX IF NOT EXISTS idx_newsletters_date      ON public.newsletters (date DESC);
CREATE INDEX IF NOT EXISTS idx_newsletters_published ON public.newsletters (published);

CREATE TRIGGER newsletters_updated_at
  BEFORE UPDATE ON public.newsletters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Newsletter editions (editable in admin)
CREATE TABLE IF NOT EXISTS public.newsletters_editions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           varchar(500) NOT NULL,
  edition_date    date NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),
  preheader       text,
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletters_editions IS 'Admin-editable newsletter editions with block-based content';

CREATE INDEX IF NOT EXISTS idx_newsletters_editions_date
  ON public.newsletters_editions (edition_date DESC);
CREATE INDEX IF NOT EXISTS idx_newsletters_editions_status
  ON public.newsletters_editions (status);

CREATE TRIGGER newsletters_editions_updated_at
  BEFORE UPDATE ON public.newsletters_editions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Newsletter edition blocks
CREATE TABLE IF NOT EXISTS public.newsletters_edition_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id      uuid NOT NULL REFERENCES public.newsletters_editions (id) ON DELETE CASCADE,
  block_type      varchar(100) NOT NULL,
  block_order     integer NOT NULL DEFAULT 0,
  content         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletters_edition_blocks_edition
  ON public.newsletters_edition_blocks (edition_id);

CREATE TRIGGER newsletters_edition_blocks_updated_at
  BEFORE UPDATE ON public.newsletters_edition_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Newsletter edition bricks (sub-blocks)
CREATE TABLE IF NOT EXISTS public.newsletters_edition_bricks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id        uuid NOT NULL REFERENCES public.newsletters_edition_blocks (id) ON DELETE CASCADE,
  brick_type      varchar(100) NOT NULL,
  brick_order     integer NOT NULL DEFAULT 0,
  content         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletters_edition_bricks_block
  ON public.newsletters_edition_bricks (block_id);

CREATE TRIGGER newsletters_edition_bricks_updated_at
  BEFORE UPDATE ON public.newsletters_edition_bricks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Newsletter edition links (short link mappings)
CREATE TABLE IF NOT EXISTS public.newsletters_edition_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id              uuid NOT NULL REFERENCES public.newsletters_editions (id) ON DELETE CASCADE,
  block_id                uuid REFERENCES public.newsletters_edition_blocks (id) ON DELETE SET NULL,
  brick_id                uuid REFERENCES public.newsletters_edition_bricks (id) ON DELETE SET NULL,
  link_type               varchar(100) NOT NULL,
  link_index              integer NOT NULL DEFAULT 0,
  original_url            text NOT NULL,
  short_path              varchar(255) NOT NULL,
  short_url               text NOT NULL,
  distribution_channel    varchar(50) NOT NULL,
  shortio_id              text,
  redirect_id             text,
  status                  varchar(20) DEFAULT 'created',
  error_message           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (edition_id, short_path, distribution_channel)
);

CREATE INDEX IF NOT EXISTS idx_newsletters_edition_links_edition
  ON public.newsletters_edition_links (edition_id);

CREATE TRIGGER newsletters_edition_links_updated_at
  BEFORE UPDATE ON public.newsletters_edition_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Block templates
CREATE TABLE IF NOT EXISTS public.newsletters_block_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(255) NOT NULL,
  block_type      varchar(100) NOT NULL,
  description     text,
  content         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER newsletters_block_templates_updated_at
  BEFORE UPDATE ON public.newsletters_block_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Brick templates
CREATE TABLE IF NOT EXISTS public.newsletters_brick_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(255) NOT NULL,
  brick_type      varchar(100) NOT NULL,
  description     text,
  content         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER newsletters_brick_templates_updated_at
  BEFORE UPDATE ON public.newsletters_brick_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_edition_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_edition_bricks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_edition_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_block_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_brick_templates ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "newsletters_select" ON public.newsletters FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_editions_select" ON public.newsletters_editions FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_edition_blocks_select" ON public.newsletters_edition_blocks FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_edition_bricks_select" ON public.newsletters_edition_bricks FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_edition_links_select" ON public.newsletters_edition_links FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_block_templates_select" ON public.newsletters_block_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_brick_templates_select" ON public.newsletters_brick_templates FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "newsletters_insert" ON public.newsletters FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_update" ON public.newsletters FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_delete" ON public.newsletters FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_editions_insert" ON public.newsletters_editions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_editions_update" ON public.newsletters_editions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_editions_delete" ON public.newsletters_editions FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_edition_blocks_insert" ON public.newsletters_edition_blocks FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_edition_blocks_update" ON public.newsletters_edition_blocks FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_edition_blocks_delete" ON public.newsletters_edition_blocks FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_edition_bricks_insert" ON public.newsletters_edition_bricks FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_edition_bricks_update" ON public.newsletters_edition_bricks FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_edition_bricks_delete" ON public.newsletters_edition_bricks FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_edition_links_insert" ON public.newsletters_edition_links FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_edition_links_update" ON public.newsletters_edition_links FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_edition_links_delete" ON public.newsletters_edition_links FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_block_templates_insert" ON public.newsletters_block_templates FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_block_templates_update" ON public.newsletters_block_templates FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_block_templates_delete" ON public.newsletters_block_templates FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "newsletters_brick_templates_insert" ON public.newsletters_brick_templates FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_brick_templates_update" ON public.newsletters_brick_templates FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_brick_templates_delete" ON public.newsletters_brick_templates FOR DELETE TO authenticated USING (public.is_admin());
