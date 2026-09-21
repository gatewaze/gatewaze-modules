-- ============================================================================
-- Migration: host_media_015_read_without_templates
-- Description: can_read_host_media() no longer errors when the templates
--              module is not installed.
--
-- 008 delegated public reads to templates.can_read_host(). plpgsql binds
-- that call when it runs, so on a deployment without the templates schema
-- EVERY user-scoped SELECT on host_media failed with "schema templates
-- does not exist" -- including an organiser's, because Postgres evaluates
-- the public-read policy alongside the admin policy that would have let
-- them in. Seen on autodb, 2026-09-21.
--
-- Now the function looks for templates.can_read_host() first and denies
-- when it is absent. Denying is the fail-closed answer: organisers still
-- read through host_media_admin_all, and the guest surfaces read on the
-- service role behind their own checks. With templates installed the
-- behaviour is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_read_host_media(
  p_host_kind text,
  p_host_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF to_regprocedure('templates.can_read_host(text, uuid)') IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT templates.can_read_host($1, $2)' INTO v_ok USING p_host_kind, p_host_id;
  RETURN coalesce(v_ok, false);
END $$;
