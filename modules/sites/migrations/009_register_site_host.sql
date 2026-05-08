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

-- The CHECK on pages_host_registrations.accepted_theme_kinds installed by
-- sites_006 only allowed ARRAY['html','nextjs']. sites_010 renames the
-- vocabulary to ARRAY['email','website']. On a fresh install,
-- migrations run alphabetically (006 → 009 → 010) so 009's insert below
-- (which uses the new 'website' vocab) would fail before 010 gets a
-- chance to relax the CHECK. Pre-emptively swap the CHECK here so 009
-- self-contains the requirement; 010 then becomes a no-op for the CHECK
-- but still runs its other DDL.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'pages_host_registrations'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%accepted_theme_kinds%html%nextjs%'
  LOOP
    EXECUTE format('ALTER TABLE public.pages_host_registrations DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.pages_host_registrations
  DROP CONSTRAINT IF EXISTS pages_host_registrations_accepted_theme_kinds_valid;
ALTER TABLE public.pages_host_registrations
  ADD CONSTRAINT pages_host_registrations_accepted_theme_kinds_valid
  CHECK (accepted_theme_kinds <@ ARRAY['email','website']::text[]);

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
