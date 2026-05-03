-- ============================================================================
-- Migration: sites_012_pages_composition_mode
-- Description: Per-page composition_mode (schema | blocks) + page wrapper FK
--              + section ordering for sub-nav.
--              Per spec-content-modules-git-architecture §8.3 + §10.
-- ============================================================================

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS composition_mode text NOT NULL DEFAULT 'schema'
  CHECK (composition_mode IN ('schema', 'blocks'));

COMMENT ON COLUMN public.pages.composition_mode IS
  'Per spec §8.3: immutable post-create. schema = pages.content JSONB conforming to route schema; blocks = page_blocks + page_block_bricks ordered list.';

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS wrapper_id uuid REFERENCES public.templates_wrappers(id);

COMMENT ON COLUMN public.pages.wrapper_id IS
  'Per spec §10.2: optional page-level wrapper. NULL = page content renders directly inside site wrapper. Auto-defaulted from gatewaze.theme.json path-prefix mapping at create time; admin can override.';

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS section_order integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pages.section_order IS
  'Explicit ordering within a section for wrappers that show sub-nav (consumed by useSectionPages).';

-- ============================================================================
-- Trigger replacing trg_page_blocks_only_for_html_pages with per-page gate
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_page_blocks_match_composition_mode()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_mode text;
BEGIN
  SELECT composition_mode INTO v_mode FROM public.pages WHERE id = NEW.page_id;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'page % does not exist', NEW.page_id USING ERRCODE = '23503';
  END IF;
  IF v_mode <> 'blocks' THEN
    RAISE EXCEPTION 'page_blocks_forbidden_for_schema_page: page % is composition_mode=%, page_blocks/page_block_bricks not allowed', NEW.page_id, v_mode
      USING ERRCODE = '23514',
            HINT = 'Create the page with composition_mode=''blocks'' or write content to pages.content JSONB instead.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_page_blocks_match_composition_mode_ins ON public.page_blocks;
CREATE TRIGGER trg_page_blocks_match_composition_mode_ins
  BEFORE INSERT ON public.page_blocks
  FOR EACH ROW EXECUTE FUNCTION public.trg_page_blocks_match_composition_mode();

-- Drop old theme-kind-gated trigger (replaced by composition-mode gate)
DROP TRIGGER IF EXISTS trg_page_blocks_only_for_html_pages_ins ON public.page_blocks;
DROP TRIGGER IF EXISTS trg_page_blocks_only_for_html_pages_ins ON public.page_block_bricks;
DROP FUNCTION IF EXISTS public.trg_page_blocks_only_for_html_pages();
