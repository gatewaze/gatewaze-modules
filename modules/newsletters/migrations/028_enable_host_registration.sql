-- ============================================================================
-- 028_enable_host_registration — flip newsletter pages_host_registrations
--                                row to enabled=true
-- ============================================================================
--
-- Per spec-builder-evaluation §3.6 (extended). Migration 020a inserts the
-- newsletter row with enabled=false (a deliberate gate from when the
-- newsletters/pages bridge wasn't ready). The unified Puck-based editor
-- + publish-to-git flow requires `templates.can_read_host('newsletter',
-- ...)` to return true so the templates_libraries insert during
-- newsletter creation passes RLS.
--
-- The `can_read_host` function returns false when enabled=false; flipping
-- the row removes that block. The `can_admin_fn` (read elsewhere via
-- pages_host_registrations) was set to `public.is_admin()` by an earlier
-- migration in this module's history; we leave it as-is here.
--
-- Idempotent.
-- ============================================================================

UPDATE public.pages_host_registrations
   SET enabled = true
 WHERE host_kind = 'newsletter'
   AND enabled = false;
