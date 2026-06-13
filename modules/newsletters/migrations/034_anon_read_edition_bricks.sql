-- ============================================================================
-- 034_anon_read_edition_bricks
-- ============================================================================
--
-- The public portal renders slot blocks (e.g. mlops_community) by loading their
-- bricks from newsletters_edition_bricks. Anon could already read
-- newsletters_edition_blocks (migration 013) but not the bricks, so slot blocks
-- showed only their header. Mirror the blocks policy for bricks.
--
-- Idempotent.
-- ============================================================================

DROP POLICY IF EXISTS newsletters_bricks_anon_select ON public.newsletters_edition_bricks;
CREATE POLICY newsletters_bricks_anon_select
  ON public.newsletters_edition_bricks
  FOR SELECT
  TO anon
  USING (true);
