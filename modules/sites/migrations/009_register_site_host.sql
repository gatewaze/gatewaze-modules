-- ============================================================================
-- Migration: sites_009_register_site_host
-- Description: Register 'site' as a pages_host_registrations row so the
--              templates RLS dispatcher (templates 005/010/011) can resolve
--              can_admin_fn for site-scoped libraries.
--
-- Without this row, templates.can_read_library(library_id) returns false
-- for every templates_libraries row with host_kind='site' — the
-- dispatcher looks up can_admin_fn from pages_host_registrations and bails
-- on missing rows. The result is INSERT into templates_libraries with
-- host_kind='site' is RLS-denied, so site creation cannot auto-provision
-- a starter library.
--
-- Idempotent: ON CONFLICT DO UPDATE keeps any operator overrides.
-- ============================================================================

INSERT INTO public.pages_host_registrations (
  host_kind,
  module_id,
  url_prefix_template,
  can_admin_fn,
  can_edit_pages_fn,
  can_publish_fn,
  default_wrapper_key,
  accepted_theme_kinds,
  enabled
)
VALUES (
  'site',
  'sites',
  '/sites/{host_id}',
  'public.can_admin_site',
  'public.can_edit_site_content',
  'public.can_admin_site',
  null,
  ARRAY['website']::text[],
  true
)
ON CONFLICT (host_kind) DO UPDATE SET
  module_id            = EXCLUDED.module_id,
  url_prefix_template  = EXCLUDED.url_prefix_template,
  can_admin_fn         = EXCLUDED.can_admin_fn,
  can_edit_pages_fn    = EXCLUDED.can_edit_pages_fn,
  can_publish_fn       = EXCLUDED.can_publish_fn,
  default_wrapper_key  = EXCLUDED.default_wrapper_key,
  accepted_theme_kinds = EXCLUDED.accepted_theme_kinds,
  enabled              = EXCLUDED.enabled;
