-- ============================================================================
-- Migration: sites_011_seed_portal_site
-- Description: Seed a "Portal" site row representing the platform's built-in
--              portal app (admin / member-facing UI). When the sites module
--              is enabled, the Portal site appears in the sites listing as a
--              first-class entry.
--
-- Mode: option B (metadata-only) per discussion. The Portal's pages are
-- file-based routes in the portal Next.js app — they are NOT editable
-- through the sites admin UI. The site row exists so:
--   - operators see "Portal" alongside their custom sites in the listing
--   - the publishing tab can show the deployed portal version (git SHA)
--   - future admin surfaces (analytics, custom domains) can attach
--
-- Idempotent: ON CONFLICT (slug) DO NOTHING. Operator-edited fields
-- (name, description, config) are preserved across re-runs.
--
-- Notes:
--   * theme_kind = 'website' (post-templates_013 rename)
--   * publishing_target = { kind: 'portal' } — sites_publishing_target_
--     matches_kind (sites_010) accepts 'portal' for website-kind sites
--   * templates_library_id = NULL — no library binding; the portal renders
--     hand-written React, not schema-driven content
--   * created_by = NULL — system seed
-- ============================================================================

INSERT INTO public.sites (
  slug,
  name,
  description,
  status,
  publishing_target,
  theme_kind,
  templates_library_id,
  config
)
VALUES (
  'portal',
  'Portal',
  'Built-in admin and member portal. Pages are managed in the portal codebase, not through the sites editor.',
  'active',
  '{"kind":"portal"}'::jsonb,
  'website',
  NULL,
  '{"isolationLevel":"shared-cookie"}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

COMMENT ON COLUMN public.sites.slug IS
  'URL-safe identifier. Reserved slugs: ''portal'' (seeded by sites_011 — represents the platform portal itself).';
