-- ============================================================================
-- 023_anon_read_defs_for_public_newsletters
-- ============================================================================
--
-- The public portal renders published newsletter editions by joining each
-- edition block to its templates_block_defs row (the declarative html/schema).
-- Until now only `authenticated` could read templates_block_defs, so the
-- anon portal got NULL templates and rendered empty editions.
--
-- Grant anon (and authenticated) SELECT on the block/brick defs, but ONLY for
-- libraries that belong to a PUBLIC, set-up newsletter collection
-- (require_login = false). Login-gated newsletters stay private; non-newsletter
-- libraries (e.g. sites) are unaffected (the EXISTS join won't match).
--
-- Idempotent.
-- ============================================================================

DROP POLICY IF EXISTS templates_block_defs_anon_read_public_newsletter ON public.templates_block_defs;
CREATE POLICY templates_block_defs_anon_read_public_newsletter
  ON public.templates_block_defs
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.newsletters_template_collections c
      WHERE c.id = public.templates_block_defs.library_id
        AND c.setup_complete = true
        AND c.require_login = false
    )
  );

DROP POLICY IF EXISTS templates_brick_defs_anon_read_public_newsletter ON public.templates_brick_defs;
CREATE POLICY templates_brick_defs_anon_read_public_newsletter
  ON public.templates_brick_defs
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.templates_block_defs b
      JOIN public.newsletters_template_collections c ON c.id = b.library_id
      WHERE b.id = public.templates_brick_defs.block_def_id
        AND c.setup_complete = true
        AND c.require_login = false
    )
  );
