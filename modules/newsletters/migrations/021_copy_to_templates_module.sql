-- ============================================================================
-- Migration: newsletters_021_copy_to_templates_module
-- Description: Copy legacy newsletter block/brick templates into the
--              templates module's tables (templates_libraries, templates_block_defs,
--              templates_brick_defs). Backfills newsletters_edition_blocks's
--              templates_block_def_id (added in migration 020) and
--              newsletters_edition_bricks's templates_brick_def_id.
--
--              The legacy table is N rows per (collection, block_type) — one
--              per variant_key (html_template / substack / beehiiv). The new
--              table has 1 row per (library, key) with `html` for HTML email
--              and `rich_text_template` for the rich-text outputs (Substack,
--              Beehiiv). This migration collapses the N→1 mapping by:
--                - using variant_key='html_template' as the canonical row
--                  whose `content.html_template` lands in templates_block_defs.html
--                - merging additional variants (substack, beehiiv) into
--                  templates_block_defs.rich_text_template (last write wins;
--                  the v0.1 templates module supports only one rich_text variant
--                  per block_def — multi-output rendering happens via the
--                  output adapter switch on adapter.id at render time)
--
-- Per the "nothing in production" caveat: we still write defensively so this
-- is replayable in a self-hosted env that DOES have data.
--
-- Idempotent. Runs after 020_link_to_templates_module.sql.
-- ============================================================================

-- ============================================================================
-- 1. Map newsletters_template_collections → templates_libraries (1-to-1)
-- ============================================================================
-- Each legacy collection becomes a templates_library with theme_kind='email'
-- (templates_libraries was added in templates 008_templates_theme_kinds;
-- renamed from 'html' to 'email' in templates_013_rename_theme_kinds).

-- Map: collection.id → templates_libraries.host_id (host_kind='newsletter').
-- Reuses the legacy collection's UUID as the new library's primary key so
-- the newsletters_editions.templates_library_id backfill (step 4) is a
-- one-line UPDATE.
INSERT INTO public.templates_libraries (id, host_kind, host_id, name, description, theme_kind, created_at, updated_at)
SELECT
  c.id,                                          -- legacy collection id reused as library id
  'newsletter'::text AS host_kind,
  c.id AS host_id,                               -- newsletter scope keyed by the collection id
  c.name,
  COALESCE(c.description, c.name) AS description,
  'email'::text AS theme_kind,
  c.created_at,
  c.updated_at
FROM public.newsletters_template_collections c
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 2. Copy newsletters_block_templates → templates_block_defs
-- ============================================================================
-- For each (collection_id, block_type) tuple we pick:
--   html       = the html_template variant's content (canonical text body)
--   schema     = the html_template variant's content.schema if present, else {}
--   rich_text_template = MAX over substack/beehiiv variants' content.template (last seen wins)

WITH html_variants AS (
  SELECT
    bt.collection_id,
    bt.block_type,
    bt.id AS legacy_id,
    bt.name,
    bt.description,
    bt.has_bricks,
    bt.created_at,
    bt.updated_at,
    -- Legacy `content` jsonb canonically holds { html_template, schema, ... }
    -- when variant_key='html_template'. Pull both.
    COALESCE(bt.content->>'html_template', bt.content->>'template', bt.content::text, '') AS html,
    COALESCE(bt.content->'schema', '{}'::jsonb) AS schema_json
  FROM public.newsletters_block_templates bt
  WHERE bt.variant_key = 'html_template'
    AND bt.is_active = true
),
rich_text_variants AS (
  SELECT
    bt.collection_id,
    bt.block_type,
    bt.variant_key,
    COALESCE(bt.content->>'template', bt.content->>'rich_text_template', bt.content::text, '') AS rich_text_template
  FROM public.newsletters_block_templates bt
  WHERE bt.variant_key <> 'html_template'
    AND bt.is_active = true
)
INSERT INTO public.templates_block_defs (
  id, library_id, key, name, description,
  source_kind, schema, html, rich_text_template, has_bricks,
  version, is_current, created_at, updated_at
)
SELECT
  hv.legacy_id AS id,
  hv.collection_id AS library_id,
  hv.block_type AS key,
  hv.name,
  hv.description,
  'static'::text AS source_kind,
  hv.schema_json AS schema,
  hv.html,
  -- Pick any rich-text variant for this (collection, block_type). If multiple,
  -- take the alphabetically-first variant_key (deterministic).
  (SELECT rv.rich_text_template
     FROM rich_text_variants rv
     WHERE rv.collection_id = hv.collection_id AND rv.block_type = hv.block_type
     ORDER BY rv.variant_key
     LIMIT 1) AS rich_text_template,
  COALESCE(hv.has_bricks, false) AS has_bricks,
  1 AS version,
  true AS is_current,
  hv.created_at,
  hv.updated_at
FROM html_variants hv
ON CONFLICT (id) DO UPDATE SET
  library_id    = EXCLUDED.library_id,
  key           = EXCLUDED.key,
  name          = EXCLUDED.name,
  description   = EXCLUDED.description,
  schema        = EXCLUDED.schema,
  html          = EXCLUDED.html,
  rich_text_template = EXCLUDED.rich_text_template,
  has_bricks    = EXCLUDED.has_bricks,
  updated_at    = now();

-- ============================================================================
-- 3. Copy newsletters_brick_templates → templates_brick_defs
-- ============================================================================
-- Bricks need a parent block_def_id. The legacy newsletters_brick_templates
-- has a `block_template_id` FK (added in migration 003). We resolve it via
-- the html_template variant of the parent block since that's what we copied
-- as the canonical block_def above.

WITH html_brick_variants AS (
  SELECT
    bt.id AS legacy_id,
    bt.block_template_id AS legacy_parent_id,
    bt.brick_type,
    bt.name,
    bt.sort_order,
    bt.created_at,
    bt.updated_at,
    COALESCE(bt.content->>'html_template', bt.content->>'template', '') AS html,
    COALESCE(bt.content->'schema', '{}'::jsonb) AS schema_json
  FROM public.newsletters_brick_templates bt
  WHERE bt.variant_key = 'html_template'
    AND bt.is_active = true
    AND bt.block_template_id IS NOT NULL
),
rich_brick_variants AS (
  SELECT
    bt.block_template_id,
    bt.brick_type,
    bt.variant_key,
    COALESCE(bt.content->>'template', '') AS rich_text_template
  FROM public.newsletters_brick_templates bt
  WHERE bt.variant_key <> 'html_template'
    AND bt.is_active = true
    AND bt.block_template_id IS NOT NULL
)
INSERT INTO public.templates_brick_defs (
  id, block_def_id, key, name, schema, html, rich_text_template, sort_order,
  created_at, updated_at
)
SELECT
  hbv.legacy_id AS id,
  hbv.legacy_parent_id AS block_def_id,    -- legacy parent id == new templates_block_defs.id (we used the same uuid above)
  hbv.brick_type AS key,
  hbv.name,
  hbv.schema_json AS schema,
  hbv.html,
  (SELECT rv.rich_text_template
     FROM rich_brick_variants rv
     WHERE rv.block_template_id = hbv.legacy_parent_id AND rv.brick_type = hbv.brick_type
     ORDER BY rv.variant_key
     LIMIT 1) AS rich_text_template,
  hbv.sort_order,
  hbv.created_at,
  hbv.updated_at
FROM html_brick_variants hbv
WHERE EXISTS (SELECT 1 FROM public.templates_block_defs WHERE id = hbv.legacy_parent_id)
ON CONFLICT (id) DO UPDATE SET
  block_def_id  = EXCLUDED.block_def_id,
  key           = EXCLUDED.key,
  name          = EXCLUDED.name,
  schema        = EXCLUDED.schema,
  html          = EXCLUDED.html,
  rich_text_template = EXCLUDED.rich_text_template,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = now();

-- ============================================================================
-- 4. Backfill newsletters_editions.templates_library_id from collection_id
-- ============================================================================

UPDATE public.newsletters_editions
SET templates_library_id = collection_id
WHERE templates_library_id IS NULL
  AND collection_id IS NOT NULL;

-- ============================================================================
-- 5. Backfill newsletters_edition_blocks.templates_block_def_id from legacy
-- ============================================================================
-- The block_template_id on edition_blocks points at the legacy block_template
-- variant (html_template). Since we used the legacy id as the new
-- templates_block_defs.id for the html_template variant, the FK is preserved.
-- For non-html variants on edition_blocks (rare in practice) we resolve via
-- the (collection, block_type) tuple.

UPDATE public.newsletters_edition_blocks eb
SET templates_block_def_id = eb.block_template_id
WHERE eb.templates_block_def_id IS NULL
  AND eb.block_template_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.templates_block_defs WHERE id = eb.block_template_id);

-- For rows whose block_template_id is a non-html-template variant, look up
-- the canonical block_def via (collection, block_type).
UPDATE public.newsletters_edition_blocks eb
SET templates_block_def_id = canon.id
FROM public.newsletters_block_templates legacy_bt
JOIN public.templates_block_defs canon
  ON canon.library_id = legacy_bt.collection_id
 AND canon.key = legacy_bt.block_type
WHERE eb.templates_block_def_id IS NULL
  AND eb.block_template_id = legacy_bt.id;

-- ============================================================================
-- 6. (Optional) Backfill brick FKs on newsletters_edition_block_bricks
-- ============================================================================
-- newsletters_edition_block_bricks has brick_template_id (legacy). The
-- complementary FK column to templates_brick_defs is added below.

ALTER TABLE public.newsletters_edition_block_bricks
  ADD COLUMN IF NOT EXISTS templates_brick_def_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'newsletters_edition_block_bricks_templates_brick_def_fk'
  ) THEN
    ALTER TABLE public.newsletters_edition_block_bricks
      ADD CONSTRAINT newsletters_edition_block_bricks_templates_brick_def_fk
        FOREIGN KEY (templates_brick_def_id)
        REFERENCES public.templates_brick_defs(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS newsletters_edition_block_bricks_templates_brick_def_idx
  ON public.newsletters_edition_block_bricks (templates_brick_def_id);

-- Backfill where the legacy brick_template_id maps directly.
UPDATE public.newsletters_edition_block_bricks ebb
SET templates_brick_def_id = ebb.brick_template_id
WHERE ebb.templates_brick_def_id IS NULL
  AND ebb.brick_template_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.templates_brick_defs WHERE id = ebb.brick_template_id);

-- ============================================================================
-- Notes for the operator
-- ============================================================================
-- This migration COPIES data; the legacy tables remain in place until
-- migration 022_drop_legacy_template_tables.sql is run. That follow-up
-- migration is gated on the application code being fully cut over to
-- the new tables. See the data-access bridge in lib/templates-bridge/
-- for the read-side helpers.
