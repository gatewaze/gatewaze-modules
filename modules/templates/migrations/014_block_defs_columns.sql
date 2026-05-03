-- ============================================================================
-- Migration: templates_014_block_defs_columns
-- Description: Block-kinds taxonomy + audience awareness + content-source
--              format + wrapper-grammar consent gates. Per
--              spec-content-modules-git-architecture §9 + §13.
-- ============================================================================

-- 1. block_kind (taxonomy)
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS block_kind text NOT NULL DEFAULT 'static'
  CHECK (block_kind IN (
    'static', 'ai-generated', 'gatewaze-internal',
    'user-personalized', 'external-fetched', 'embed', 'computed'
  ));

COMMENT ON COLUMN public.templates_block_defs.block_kind IS
  'Per spec §9: declares content origin + editor surface + render pipeline. v1: static, ai-generated, gatewaze-internal, user-personalized. v1.x: external-fetched, embed, computed.';

-- 2. kind_config_schema — JSON Schema for kind-specific config (alongside content_schema)
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS kind_config_schema jsonb;

COMMENT ON COLUMN public.templates_block_defs.kind_config_schema IS
  'JSON Schema describing kind-specific config fields. Editor renders a form from this schema for the admin to set fetcher/AI/source config per block instance.';

-- 3. audience — public / authenticated / authenticated_optional
-- Default 'public': blocks render identically for anon and authenticated viewers (conservative).
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'public'
  CHECK (audience IN ('public', 'authenticated', 'authenticated_optional'));

COMMENT ON COLUMN public.templates_block_defs.audience IS
  'Per spec §12.4: public renders identically for both states; authenticated hides for anon; authenticated_optional renders with branching logic via useCurrentUser().';

-- 4. freshness — only applicable to gatewaze-internal and external-fetched
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS freshness text
  CHECK (freshness IS NULL OR freshness IN ('live', 'build-time'));

COMMENT ON COLUMN public.templates_block_defs.freshness IS
  'Per spec §9.6: NULL for kinds where freshness inapplicable (static, ai-generated, embed, computed, user-personalized). Required (live | build-time) for gatewaze-internal and external-fetched. Enforced by trg_block_def_freshness_required.';

-- 5. component_export_path — e.g. './components/Hero' (for tsx-marker source format)
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS component_export_path text;

COMMENT ON COLUMN public.templates_block_defs.component_export_path IS
  'For tsx-marker source format: relative path from theme repo root to component file (e.g., ./components/Hero).';

-- 6. source_format — html-marker | mjml-marker | tsx-marker | manifest
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'html-marker'
  CHECK (source_format IN ('html-marker', 'mjml-marker', 'tsx-marker', 'manifest'));

COMMENT ON COLUMN public.templates_block_defs.source_format IS
  'How the block-def was authored: html-marker (legacy + emails), mjml-marker (newsletter MJML), tsx-marker (Next.js TSX with @gatewaze:block markers), manifest (gatewaze.blocks.json declaration).';

-- 7. requires_consent — array of compliance categories required to render the block
ALTER TABLE public.templates_block_defs
  ADD COLUMN IF NOT EXISTS requires_consent text[];

COMMENT ON COLUMN public.templates_block_defs.requires_consent IS
  'Per spec §13.2: when compliance module installed, block renders only if user has consented to all listed categories. Otherwise renders "consent required" placeholder. NULL = no consent gate.';

-- ============================================================================
-- Trigger enforcing the freshness/kind invariant (per spec §9.6)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_block_def_freshness_required()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.block_kind IN ('gatewaze-internal', 'external-fetched')) AND NEW.freshness IS NULL THEN
    RAISE EXCEPTION 'block_kind % requires freshness to be set (live or build-time)', NEW.block_kind
      USING ERRCODE = '23514', HINT = 'Set freshness=''live'' or freshness=''build-time''';
  END IF;
  IF (NEW.block_kind NOT IN ('gatewaze-internal', 'external-fetched')) AND NEW.freshness IS NOT NULL THEN
    RAISE EXCEPTION 'block_kind % does not support freshness; column must be NULL', NEW.block_kind
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_block_def_freshness_required_ins_upd ON public.templates_block_defs;
CREATE TRIGGER trg_block_def_freshness_required_ins_upd
  BEFORE INSERT OR UPDATE ON public.templates_block_defs
  FOR EACH ROW EXECUTE FUNCTION public.trg_block_def_freshness_required();

-- ============================================================================
-- Page-block instance tracking columns (kind-specific config + generation state)
-- ============================================================================

ALTER TABLE public.page_blocks
  ADD COLUMN IF NOT EXISTS kind_config jsonb;

COMMENT ON COLUMN public.page_blocks.kind_config IS
  'Per-instance config conforming to the block-def''s kind_config_schema. E.g., for gatewaze-internal block: { filter, sort, limit }.';

ALTER TABLE public.page_blocks
  ADD COLUMN IF NOT EXISTS last_generated_at timestamptz;

COMMENT ON COLUMN public.page_blocks.last_generated_at IS
  'For ai-generated and external-fetched: when content was last computed. Drives staleness UI.';

ALTER TABLE public.page_blocks
  ADD COLUMN IF NOT EXISTS generation_status text
  CHECK (generation_status IS NULL OR generation_status IN ('fresh', 'stale', 'pending', 'failed'));

COMMENT ON COLUMN public.page_blocks.generation_status IS
  'NULL for static blocks. fresh = last_generated_at within staleness window. stale = needs regen. pending = job in flight. failed = retries exhausted.';
