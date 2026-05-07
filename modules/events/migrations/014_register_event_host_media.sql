-- ============================================================================
-- Migration: events_014_register_event_host_media
-- Description: Adds an `event` branch to the host-media dispatch
--              function. Per spec-host-media-module §3.2 — consumer
--              modules opt in to host-media by extending the dispatch
--              fn with their own host_kind branch via CREATE OR REPLACE.
--
--              `public.can_admin_event(uuid)` already exists (events/
--              migrations/002_events_rls_functions.sql + the platform's
--              supabase/migrations/00006_rls_policies.sql) so we just
--              wire it into the dispatch.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_admin_host_media(
  p_host_kind text,
  p_host_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
  CASE p_host_kind
    WHEN 'site' THEN
      RETURN public.can_admin_site(p_host_id);
    WHEN 'newsletter' THEN
      RETURN public.can_admin_newsletter(p_host_id);
    WHEN 'event' THEN
      RETURN public.can_admin_event(p_host_id);
    ELSE
      RETURN false;
  END CASE;
END $$;

-- can_read_host_media currently delegates to templates.can_read_host
-- which dispatches via pages_host_registrations. Events doesn't ship a
-- pages_host_registration row (events aren't a "host" for templates'
-- pages/page_blocks), so reads on event-host_media rely on the public
-- access_level path (most event media is access_level='public') rather
-- than the registration-driven dispatch. If/when events grow private
-- media, add the registration here.
