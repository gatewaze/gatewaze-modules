-- ============================================================================
-- competitions_007_register_category_adapter
--
-- Per spec-unified-content-management §3.2: register events_competitions
-- with the universal content_category_adapters trigger so the membership
-- module's keyword rules apply member-vs-community categorisation
-- automatically.
--
-- Migration 002 added content_category. Migration 006 registered the
-- publish-adapter but didn't register the category adapter. This closes
-- that gap.
--
-- Idempotent (register_category_adapter UPSERTs).
-- ============================================================================

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_category_adapters'
  ) THEN
    RAISE NOTICE '[competitions/007] content-platform not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events_competitions'
      AND column_name = 'content_category'
  ) THEN
    RAISE NOTICE '[competitions/007] events_competitions.content_category missing; skipping';
    RETURN;
  END IF;

  PERFORM public.register_category_adapter(
    p_content_type => 'competition',
    p_table_name   => 'public.events_competitions'::regclass,
    p_category_col => 'content_category'
  );
END $register$;
