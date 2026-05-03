-- ============================================================================
-- Migration: templates_015_wrappers_role
-- Description: Add `role` column to templates_wrappers to distinguish
--              site-level wrappers from page-level wrappers.
--              Per spec-content-modules-git-architecture §10.6.
-- ============================================================================

ALTER TABLE public.templates_wrappers
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'site'
  CHECK (role IN ('site', 'page'));

COMMENT ON COLUMN public.templates_wrappers.role IS
  'Per spec §10.1: site = renders globally for every page (header/nav/footer); page = renders inside site wrapper for a section (sub-nav/sidebar). One site wrapper per library required for role=site assignment; multiple page wrappers allowed.';

-- Index for picking the default site wrapper per library
CREATE INDEX IF NOT EXISTS idx_templates_wrappers_library_role
  ON public.templates_wrappers (library_id, role);
