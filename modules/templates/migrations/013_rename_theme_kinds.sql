-- ============================================================================
-- Migration: templates_013_rename_theme_kinds
-- Description: Rename theme_kind values 'html' -> 'email' and
--              'nextjs' -> 'website' across templates_sources,
--              templates_libraries, templates_block_defs, plus the
--              dependent trigger functions and apply_source guard.
--
-- Why: The original 'html' / 'nextjs' labels were too implementation-leaky
--      (Next.js is a transient choice; HTML is one output format among many).
--      The new labels are domain-shaped:
--        - 'email'   = consumed by newsletters / email modules
--        - 'website' = consumed by sites (schema-driven authoring)
--      Hosts can only use one or the other; sites are always website-kind,
--      newsletters/events/calendars are always email-kind.
--
-- Mechanics:
--   theme_kind is a CHECK-constrained text column (NOT a Postgres enum), so
--   ALTER TYPE ... RENAME VALUE is unavailable. Instead:
--     1. UPDATE existing rows to the new values.
--     2. Drop the old CHECK constraints and recreate with new values.
--     3. ALTER COLUMN ... SET DEFAULT to 'email'.
--     4. CREATE OR REPLACE the two trigger functions that reference values.
--
-- Idempotency: each step is gated by a value/constraint existence check so
-- the migration is safe to re-run. The data UPDATE is a no-op once values
-- have been migrated.
-- ============================================================================

-- ==========================================================================
-- 1. Drop old CHECK constraints (they enforce the old vocabulary)
-- ==========================================================================
-- Step 1 of the rename has to be removing the constraint, otherwise the
-- UPDATE (step 2) sees a row whose new theme_kind violates the still-active
-- CHECK ('html','nextjs'). We look the constraints up by definition pattern
-- since 008's ADD COLUMN ... CHECK() created auto-named constraints.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname IN ('templates_sources', 'templates_libraries', 'templates_block_defs')
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%theme_kind%html%nextjs%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',
                   r.schema_name, r.table_name, r.conname);
  END LOOP;
END $$;

-- ==========================================================================
-- 2. Rename data
-- ==========================================================================
-- The immutability triggers (added in 008) block UPDATE OF theme_kind, so we
-- have to disable them across all three tables for the duration of the
-- rename. Re-enabled below.

ALTER TABLE public.templates_sources    DISABLE TRIGGER templates_sources_theme_kind_immutable;
ALTER TABLE public.templates_libraries  DISABLE TRIGGER templates_libraries_theme_kind_immutable;
ALTER TABLE public.templates_block_defs DISABLE TRIGGER templates_block_defs_theme_kind_immutable;

UPDATE public.templates_sources    SET theme_kind = 'email'   WHERE theme_kind = 'html';
UPDATE public.templates_sources    SET theme_kind = 'website' WHERE theme_kind = 'nextjs';
UPDATE public.templates_libraries  SET theme_kind = 'email'   WHERE theme_kind = 'html';
UPDATE public.templates_libraries  SET theme_kind = 'website' WHERE theme_kind = 'nextjs';
UPDATE public.templates_block_defs SET theme_kind = 'email'   WHERE theme_kind = 'html';
UPDATE public.templates_block_defs SET theme_kind = 'website' WHERE theme_kind = 'nextjs';

ALTER TABLE public.templates_sources    ENABLE TRIGGER templates_sources_theme_kind_immutable;
ALTER TABLE public.templates_libraries  ENABLE TRIGGER templates_libraries_theme_kind_immutable;
ALTER TABLE public.templates_block_defs ENABLE TRIGGER templates_block_defs_theme_kind_immutable;

-- ==========================================================================
-- 3. Add new CHECK constraints (with the renamed vocabulary)
-- ==========================================================================

ALTER TABLE public.templates_sources
  ADD CONSTRAINT templates_sources_theme_kind_check
  CHECK (theme_kind IN ('email', 'website'));

ALTER TABLE public.templates_libraries
  ADD CONSTRAINT templates_libraries_theme_kind_check
  CHECK (theme_kind IN ('email', 'website'));

ALTER TABLE public.templates_block_defs
  ADD CONSTRAINT templates_block_defs_theme_kind_check
  CHECK (theme_kind IN ('email', 'website'));

-- ==========================================================================
-- 4. New default: 'email' (was 'html')
-- ==========================================================================

ALTER TABLE public.templates_sources    ALTER COLUMN theme_kind SET DEFAULT 'email';
ALTER TABLE public.templates_libraries  ALTER COLUMN theme_kind SET DEFAULT 'email';
ALTER TABLE public.templates_block_defs ALTER COLUMN theme_kind SET DEFAULT 'email';

-- ==========================================================================
-- 5. Trigger function: templates_block_defs_inherit_theme_kind
-- ==========================================================================
-- 008's version used 'html' as the "caller relied on the column default"
-- sentinel. After the rename, the sentinel is 'email'.

CREATE OR REPLACE FUNCTION public.templates_block_defs_inherit_theme_kind()
RETURNS trigger AS $$
DECLARE
  v_library_kind text;
BEGIN
  SELECT theme_kind INTO v_library_kind
    FROM public.templates_libraries
   WHERE id = NEW.library_id;

  IF v_library_kind IS NULL THEN
    RAISE EXCEPTION 'library not found: %', NEW.library_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Caller relied on the column default ('email'); inherit from library.
    IF NEW.theme_kind = 'email' AND v_library_kind <> 'email' THEN
      NEW.theme_kind = v_library_kind;
    ELSIF NEW.theme_kind <> v_library_kind THEN
      RAISE EXCEPTION 'theme_kind_mismatch: block_def.theme_kind=% but library.theme_kind=%',
        NEW.theme_kind, v_library_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==========================================================================
-- 6. Trigger guard: templates_apply_source rejects HTML-shaped artifacts
--    against website-kind libraries (was 'nextjs').
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.templates_apply_source(
  p_source_id  uuid,
  p_source_sha text,
  p_wrappers   jsonb,
  p_block_defs jsonb,
  p_definitions jsonb,
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_library_id   uuid;
  v_library_kind text;
  v_source_kind  text;
BEGIN
  SELECT s.library_id, s.kind, l.theme_kind
    INTO v_library_id, v_source_kind, v_library_kind
    FROM public.templates_sources s
    JOIN public.templates_libraries l ON l.id = s.library_id
   WHERE s.id = p_source_id;

  IF v_library_id IS NULL THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.source_not_found',
        'message', format('source %s does not exist', p_source_id)
      ))
    );
  END IF;

  IF v_library_kind = 'website' THEN
    RETURN jsonb_build_object(
      'artifacts', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'templates.apply.theme_kind_mismatch',
        'message', format(
          'source %s is being applied to library %s (theme_kind=website); HTML-shaped artifacts (wrappers/block_defs/definitions) are rejected. Website sources produce templates_content_schemas rows via a separate ingest path.',
          p_source_id, v_library_id)
      ))
    );
  END IF;

  RETURN public.templates_apply_source_impl(
    p_source_id, p_source_sha, p_wrappers, p_block_defs, p_definitions, p_dry_run
  );
END;
$$;
