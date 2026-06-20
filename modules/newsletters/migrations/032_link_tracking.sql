-- ============================================================================
-- Module: newsletters
-- Migration: 032_link_tracking
-- Description: Repurpose newsletters_edition_links as the per-occurrence link
--              registry for block-level click tracking (spec-newsletter-link-
--              tracking.md). Replaces the old short-link generator columns with
--              an opaque `tracking_key` ("nlb") and denormalised lineage fields.
--              Also adds optional `tracking_slug` to edition blocks for stable
--              recurring-slot tracking.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Optional stable recurring-slot key on blocks (e.g. "always-top sponsor").
--    Rollups group by COALESCE(tracking_slug, block_type).
-- ----------------------------------------------------------------------------
ALTER TABLE public.newsletters_edition_blocks
  ADD COLUMN IF NOT EXISTS tracking_slug text;

-- ----------------------------------------------------------------------------
-- 2. Rebuild newsletters_edition_links as the tracking registry.
--    The legacy short-link rows are obsolete under SendGrid click tracking, so
--    the table is cleared and re-shaped. Registry rows are (re)built at send.
-- ----------------------------------------------------------------------------
TRUNCATE TABLE public.newsletters_edition_links;

-- Drop the old short-link UNIQUE(edition_id, short_path, distribution_channel).
-- Its auto-generated name is truncated/unstable, so drop any existing UNIQUE
-- constraint on the table by introspection (only the legacy one exists here;
-- the new uniques are added further down). This also unblocks the column drops.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.newsletters_edition_links'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.newsletters_edition_links DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

-- Expand/contract (spec §5.9): this is the COEXIST release. The legacy
-- short-link columns are obsolete under SendGrid click tracking, but rather
-- than DROP COLUMN here (destructive, breaks single-release rollback, and
-- rejected by the migration linter) we only relax their NOT NULL so the new
-- registry rows — which never set them — can insert. The columns are left in
-- place, inert; a later N+1 migration drops them once nothing reads them.
-- (The table is truncated above, so the legacy values are already gone.)
-- shortio_id / redirect_id / status / error_message are already nullable.
ALTER TABLE public.newsletters_edition_links
  ALTER COLUMN link_type            DROP NOT NULL,
  ALTER COLUMN short_path           DROP NOT NULL,
  ALTER COLUMN short_url            DROP NOT NULL,
  ALTER COLUMN distribution_channel DROP NOT NULL;

-- New registry columns.
ALTER TABLE public.newsletters_edition_links
  ADD COLUMN IF NOT EXISTS tracking_key  text,
  ADD COLUMN IF NOT EXISTS block_type    text,
  ADD COLUMN IF NOT EXISTS tracking_slug text,
  ADD COLUMN IF NOT EXISTS field         text;

-- link_index already exists (001); ensure default.
ALTER TABLE public.newsletters_edition_links
  ALTER COLUMN link_index SET DEFAULT 0;

-- After the truncate the table is empty, so NOT NULL adds are safe.
ALTER TABLE public.newsletters_edition_links
  ALTER COLUMN tracking_key SET NOT NULL,
  ALTER COLUMN block_type   SET NOT NULL,
  ALTER COLUMN field        SET NOT NULL,
  ALTER COLUMN block_id     SET NOT NULL;

-- Opaque public id used as ?nlb=.
ALTER TABLE public.newsletters_edition_links
  ADD CONSTRAINT newsletters_edition_links_tracking_key_key UNIQUE (tracking_key);

-- Idempotent re-save key: one row per (block, field, position).
ALTER TABLE public.newsletters_edition_links
  ADD CONSTRAINT newsletters_edition_links_occurrence_key UNIQUE (block_id, field, link_index);

CREATE INDEX IF NOT EXISTS idx_nel_edition    ON public.newsletters_edition_links (edition_id);
CREATE INDEX IF NOT EXISTS idx_nel_block_type ON public.newsletters_edition_links (block_type);
CREATE INDEX IF NOT EXISTS idx_nel_block      ON public.newsletters_edition_links (block_id);

COMMENT ON TABLE public.newsletters_edition_links IS
  'Per-occurrence link registry for block-level click tracking. tracking_key is the opaque ?nlb= value; clicks resolve back to (edition, block, block_type) via email_interactions.';
COMMENT ON COLUMN public.newsletters_edition_links.tracking_key IS 'Opaque URL-safe id placed in links as ?nlb=. UNIQUE.';
COMMENT ON COLUMN public.newsletters_edition_links.field IS 'Field/anchor the link came from (e.g. body, cta_link, body:html:2).';

-- RLS already enabled on this table (001). The existing authenticated SELECT +
-- admin write policies continue to apply unchanged.
