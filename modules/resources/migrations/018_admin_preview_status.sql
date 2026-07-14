-- ============================================================================
-- structured-resources — admin draft preview.
--
-- Collections and items carry a status ('draft' | 'published' | 'archived').
-- Only 'published' is visible on public surfaces (portal, /md, feeds, sitemap,
-- public API, MCP) — enforced by the anon/authenticated SELECT policies which
-- filter on status = 'published'.
--
-- This migration lets an authenticated ADMIN (is_admin() = super_admin / admin /
-- editor) read rows of ANY status, so unpublished collections/items can be
-- previewed in place on the live portal before going live. The portal pages
-- opt an admin session into including draft rows (and badge them "Draft");
-- everyone else is unaffected and still sees published-only.
--
-- Mirrors the platform's existing draft-preview model (lib/modules/draftAccess.ts
-- + lib/permissions/resolve.ts) which gates unreleased content on an active
-- admin account, read-only.
-- ============================================================================

DO $preview$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sr_collections', 'sr_categories', 'sr_items', 'sr_sections', 'sr_blocks']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_admin_preview', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_admin())',
        t || '_admin_preview', t
      );
    END IF;
  END LOOP;
END $preview$;
