-- ============================================================================
-- newsletters_025_register_category_adapter
--
-- Per spec-unified-content-management §3.2 + the user's stated requirement
-- in §1: "All content needs to have the content category applied, set to
-- 'member' if it features a member company."
--
-- newsletters_editions has a content_category column (added in migration 004
-- back when categorisation was per-module). Migration 018 registered the
-- content type with the publish-adapter registry but skipped the category
-- adapter — this closes that gap so newsletter editions get member-vs-
-- community categorisation via the universal trigger driven by the
-- lf-gatewaze-modules/membership rules.
--
-- Idempotent: register_category_adapter is itself UPSERT-style (drops +
-- recreates the row). Safe to re-run if applied out-of-order.
-- ============================================================================

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_category_adapters'
  ) THEN
    RAISE NOTICE '[newsletters/025] content-platform not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'newsletters_editions'
      AND column_name = 'content_category'
  ) THEN
    RAISE NOTICE '[newsletters/025] newsletters_editions.content_category missing; skipping (migration 004 should have added it)';
    RETURN;
  END IF;

  PERFORM public.register_category_adapter(
    p_content_type => 'newsletter_edition',
    p_table_name   => 'public.newsletters_editions'::regclass,
    p_category_col => 'content_category'
  );
END $register$;
