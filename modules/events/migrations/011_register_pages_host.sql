-- ============================================================================
-- Migration: events_011_register_pages_host
-- Description: Cross-host phase 2 (per spec-sites-module §10.1).
--              Events opt into the pages namespace as host_kind='event'.
--              An event can have child pages (agenda, sponsors, FAQ, etc.)
--              keyed by host_id=events.id.
--
-- Depends on:
--   - sites module's pages_host_registrations table (already in place)
--   - events module's can_admin_event(uuid) function (migration 010)
--
-- Permission model:
--   - admin   = event admin (can create/delete pages, publish)
--   - edit    = event admin (single role for now; finer-grained roles later)
--   - publish = event admin
--
-- accepted_theme_kinds=['email'] only; events host email-kind page content
-- (block-list editor) but NOT website pages — the schema-driven flow is
-- gated to top-level sites for now.
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
  'event',
  'events',
  '/events/{host_id}',
  'public.can_admin_event',
  'public.can_admin_event',
  'public.can_admin_event',
  null,
  ARRAY['email']::text[],
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

-- The pages RLS policies live in the sites module (migration 005); they
-- look up the registered can_*_fn names from pages_host_registrations and
-- invoke them dynamically. No additional RLS is needed here.

COMMENT ON COLUMN public.pages_host_registrations.url_prefix_template IS
  'Templated URL prefix for host pages. {host_id} is substituted at admin/portal-link generation time. Events: /events/<event-id>/<page-slug>.';
