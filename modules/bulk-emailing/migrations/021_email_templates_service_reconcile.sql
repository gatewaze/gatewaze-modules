-- ============================================================================
-- bulk-emailing 021: reconcile email_templates schema with the admin service
--
-- The admin Emails feature (EmailTemplateService + EventCommunicationsTab
-- "Load Template" + speaker/sponsor/member comms) was carried over verbatim
-- from the old gatewaze-admin repo and reads/writes columns the modular-stack
-- email_templates table never had. Core 00005 created the table with
-- html_body/text_body/variables; core 00010 added created_by; bulk-emailing
-- 005 added template_scope. But the service reads/writes content_html,
-- description, sendgrid_from_key, available_scopes, and created_by_admin_id --
-- none of which any migration created. Consequences on the modular stack:
--   * creating/editing a template throws PGRST204 ("could not find the
--     'available_scopes' column of 'email_templates'");
--   * any comms flow configured to use a SAVED template sends an empty body,
--     because the send path reads template.content_html which is undefined.
-- This has been latently broken since the module split (it never worked on a
-- new-stack deployment; the old repo's 20251203000001_create_email_templates
-- migration had all these columns).
--
-- Additive + idempotent only -- no RENAME/DROP (the migration linter forbids
-- them). We KEEP the existing created_by column + FK because it powers the
-- `created_by:admin_profiles(...)` embed the service selects, and ADD
-- created_by_admin_id as the scalar the service actually reads for ownership
-- (getTemplatesForAdmin) and writes on insert. content_html is backfilled from
-- html_body so existing rows keep their body under the name the code reads;
-- created_by_admin_id is backfilled from created_by.
-- ============================================================================

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS content_html text;

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS sendgrid_from_key text;

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS available_scopes text[] NOT NULL
  DEFAULT ARRAY['customer', 'sponsor', 'event']::text[];

-- Scalar owner id the service reads and writes. Deliberately WITHOUT a FK to
-- admin_profiles: the existing created_by column already carries that FK, and a
-- second FK to the same table would make the `created_by:admin_profiles(...)`
-- embed ambiguous (PGRST201) on every template query.
ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS created_by_admin_id uuid;

-- Backfill rows authored under the old column names so nothing loses its body
-- or ownership when the service starts reading the new columns.
UPDATE public.email_templates
  SET content_html = html_body
  WHERE content_html IS NULL AND html_body IS NOT NULL;

UPDATE public.email_templates
  SET created_by_admin_id = created_by
  WHERE created_by_admin_id IS NULL AND created_by IS NOT NULL;
