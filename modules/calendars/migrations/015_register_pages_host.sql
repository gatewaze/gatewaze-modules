-- ============================================================================
-- Migration: calendars_015_register_pages_host
-- Description: Cross-host phase 2 (per spec-sites-module §10.1).
--              Calendars opt into the pages namespace as host_kind='calendar'.
--              A calendar can have a landing page + child pages keyed by
--              host_id=calendars.id.
--
-- Depends on:
--   - sites module's pages_host_registrations table (already in place)
--   - calendars module's can_admin_calendar(uuid) function (migration 001)
--
-- Permission model:
--   - admin   = calendar admin
--   - edit    = calendar admin
--   - publish = calendar admin
--
-- accepted_theme_kinds=['email'] only.
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
  'calendar',
  'calendars',
  '/calendars/{host_id}',
  'public.can_admin_calendar',
  'public.can_admin_calendar',
  'public.can_admin_calendar',
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
