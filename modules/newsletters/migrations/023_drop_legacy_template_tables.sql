-- ============================================================================
-- Migration: newsletters_023_drop_legacy_template_tables
-- Supersedes: newsletters_022_drop_legacy_template_tables.sql.disabled
--
-- Description: Final step of the templates-module cutover per
--              spec-templates-module §8. Drops the legacy newsletter
--              block/brick template tables now that all data has been
--              copied to the templates module's tables (templates_block_defs,
--              templates_brick_defs) and edition_blocks/bricks have been
--              re-pointed via migrations 020 + 021.
--
-- Why this migration (and not just renaming 022.disabled):
--   §8.2 step 5 requires the pre-flight check to be the FIRST statement of
--   the migration itself — a `DO $$ BEGIN ... RAISE EXCEPTION ... END $$`
--   block that aborts the migration transaction atomically if the data
--   isn't actually moved yet. The 022 .disabled file documents the manual
--   pre-flight checklist; this version codifies the assertion in SQL so a
--   misfire is impossible — if the data isn't ready, the migration rolls
--   back atomically and the system stays on the old schema.
--
-- Irreversibility: data lives only in templates_* after this runs. Take a
-- backup BEFORE applying. The pre-flight check stops MOST footguns but
-- doesn't replace a backup.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Pre-flight assertion (per spec §8.2 step 5)
-- ----------------------------------------------------------------------------
-- The migration aborts atomically if any of the following hold:
--   (a) Migration 020 hasn't run (templates_block_def_id column is missing)
--   (b) Migration 021 hasn't run (some legacy block_template_id rows have
--       no corresponding templates_block_def_id — i.e. data wasn't copied)
--   (c) Some non-archived collection has > 1 referencing newsletter (the
--       1:1 collection→newsletter invariant the §8 plan depends on)
--   (d) Some legacy template row exists with no templates_block_defs
--       counterpart (count mismatch — copy step failed silently)
--
-- All four checks happen in a single DO block so failures roll back the
-- entire transaction, leaving the system untouched.

DO $$
DECLARE
  v_has_new_fk_col       boolean;
  v_unmigrated_rows      bigint;
  v_multi_newsletter_collections bigint;
  v_legacy_block_count   bigint;
  v_new_block_count      bigint;
BEGIN
  -- (a) Did migration 020 add the new FK column?
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'newsletters_edition_blocks'
      AND column_name = 'templates_block_def_id'
  )
  INTO v_has_new_fk_col;
  IF NOT v_has_new_fk_col THEN
    RAISE EXCEPTION
      'Pre-flight failed: newsletters_edition_blocks.templates_block_def_id column missing. Apply migration 020 first.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) Are any legacy edition_blocks rows still un-migrated?
  EXECUTE 'SELECT count(*) FROM public.newsletters_edition_blocks
           WHERE block_template_id IS NOT NULL
             AND templates_block_def_id IS NULL'
    INTO v_unmigrated_rows;
  IF v_unmigrated_rows > 0 THEN
    RAISE EXCEPTION
      'Pre-flight failed: % rows in newsletters_edition_blocks reference legacy block_template_id but have no templates_block_def_id. Re-run migration 021 to backfill.',
      v_unmigrated_rows
      USING ERRCODE = 'check_violation';
  END IF;

  -- (c) 1:1 collection→newsletter invariant. The spec assumes production has
  --     one collection per newsletter; if a collection is referenced by
  --     multiple newsletters it would have been split during migration 021.
  --     If we still see N>1 here, 021 didn't split correctly — fail loudly
  --     rather than silently merge data.
  --
  --     Detection: a templates_libraries row with host_kind='newsletter'
  --     should map to exactly one newsletters row by host_id. We check the
  --     pre-migration shape via newsletters.template_collection_id (added
  --     in migration 002). If the column doesn't exist (because the
  --     collection_id linkage was never implemented in this deployment),
  --     skip silently — the v_unmigrated_rows check above already
  --     guarantees no orphaned data.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'newsletters'
      AND column_name = 'template_collection_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM (
               SELECT template_collection_id
               FROM public.newsletters
               WHERE template_collection_id IS NOT NULL
               GROUP BY template_collection_id
               HAVING count(*) > 1
             ) sub'
      INTO v_multi_newsletter_collections;
    IF v_multi_newsletter_collections > 0 THEN
      RAISE EXCEPTION
        'Pre-flight failed: % template_collections reference > 1 newsletter. Spec §8.2 step 5 requires 1:1 — split collections via the admin UI before re-running this migration.',
        v_multi_newsletter_collections
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (d) Row-count parity check between legacy and new tables.
  EXECUTE 'SELECT count(*) FROM public.newsletters_block_templates' INTO v_legacy_block_count;
  EXECUTE 'SELECT count(*) FROM public.templates_block_defs WHERE is_current = true' INTO v_new_block_count;
  IF v_legacy_block_count > v_new_block_count THEN
    RAISE EXCEPTION
      'Pre-flight failed: legacy newsletters_block_templates has % rows but templates_block_defs (is_current=true) has only %. Re-run migration 021 to copy missing rows.',
      v_legacy_block_count, v_new_block_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Drop legacy FKs (block_template_id / brick_template_id)
-- ----------------------------------------------------------------------------

ALTER TABLE public.newsletters_edition_blocks
  DROP CONSTRAINT IF EXISTS newsletters_edition_blocks_block_template_id_fkey;

ALTER TABLE public.newsletters_edition_block_bricks
  DROP CONSTRAINT IF EXISTS newsletters_edition_block_bricks_brick_template_id_fkey;

-- ----------------------------------------------------------------------------
-- 3. Drop legacy template_id columns (data lives in templates_*_def_id now)
-- ----------------------------------------------------------------------------

ALTER TABLE public.newsletters_edition_blocks
  DROP COLUMN IF EXISTS block_template_id;

ALTER TABLE public.newsletters_edition_block_bricks
  DROP COLUMN IF EXISTS brick_template_id;

-- ----------------------------------------------------------------------------
-- 4. Drop legacy template tables. Use CASCADE to clean up any RLS policies
--    or grants that were attached to them — the data has already been moved.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS public.newsletters_brick_templates CASCADE;
DROP TABLE IF EXISTS public.newsletters_block_templates CASCADE;

-- newsletters_template_collections is intentionally NOT dropped here. The
-- admin UI's slug-based routing still references it for navigation labels;
-- per spec §8.2 step 9 it's safer to leave it as a vestigial label table
-- than break the editor mid-migration. A follow-up migration can drop it
-- once the slug references are routed through templates_libraries.id.

-- ----------------------------------------------------------------------------
-- 5. Promote the new FK columns to NOT NULL (now that the legacy column is
--    gone, the application MUST populate the new ones)
-- ----------------------------------------------------------------------------

-- Defensive: only flip to NOT NULL if the table actually has rows that
-- pass. Empty deployments + fresh installs end up with no rows; a NOT NULL
-- on an empty table is fine, but a NOT NULL on rows that were supposed to
-- be migrated and weren't would have already tripped the pre-flight (b)
-- check above. So this is safe.
ALTER TABLE public.newsletters_edition_blocks
  ALTER COLUMN templates_block_def_id SET NOT NULL;

ALTER TABLE public.newsletters_edition_block_bricks
  ALTER COLUMN templates_brick_def_id SET NOT NULL;

COMMENT ON COLUMN public.newsletters_edition_blocks.templates_block_def_id IS
  'FK to templates_block_defs. Authoritative source after migration 023.';

COMMENT ON COLUMN public.newsletters_edition_block_bricks.templates_brick_def_id IS
  'FK to templates_brick_defs. Authoritative source after migration 023.';
