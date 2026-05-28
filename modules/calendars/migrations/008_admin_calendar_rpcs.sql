-- =====================================================================
-- Admin Calendar RPCs
-- =====================================================================
--
-- Provides the three RPCs the admin UI calls to resolve what calendars
-- and events an admin can see, and to batch-count members per calendar:
--
--   - admin_get_calendars(p_admin_id uuid)
--   - admin_get_events(p_admin_id uuid)
--   - get_calendar_members_counts(p_calendar_ids uuid[])
--
-- Rules:
--   - Super admins (role = 'super_admin') see ALL active calendars/events
--     with permission_level 'manage'.
--   - Other admins see only the calendars they have an explicit row for
--     in admin_calendar_permissions (is_active = true, not expired), plus
--     events belonging to those calendars via calendars_events.
--   - All functions are SECURITY DEFINER so the service role and
--     authenticated role can call them without broad table grants.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. admin_get_calendars(p_admin_id uuid)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_calendars(p_admin_id uuid)
RETURNS TABLE (
  calendar_id      uuid,
  permission_level text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM public.admin_profiles
  WHERE id = p_admin_id AND is_active = true;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN QUERY
      SELECT c.id, 'manage'::text
      FROM public.calendars c
      WHERE c.is_active = true;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT acp.calendar_id, acp.permission_level
    FROM public.admin_calendar_permissions acp
    JOIN public.calendars c ON c.id = acp.calendar_id
    WHERE acp.admin_id = p_admin_id
      AND acp.is_active = true
      AND (acp.expires_at IS NULL OR acp.expires_at > now())
      AND c.is_active = true;
END;
$$;

COMMENT ON FUNCTION public.admin_get_calendars(uuid)
  IS 'Calendars the given admin can access, with their permission level. Super admins see all active calendars as "manage".';

GRANT EXECUTE ON FUNCTION public.admin_get_calendars(uuid) TO authenticated, service_role, anon;

-- ---------------------------------------------------------------------
-- 2. admin_get_events(p_admin_id uuid)
-- ---------------------------------------------------------------------
-- Maps from calendar permissions → events via the calendars_events join.
-- permission_source is 'super_admin' for super admins, 'calendar' for
-- calendar-granted permissions.
CREATE OR REPLACE FUNCTION public.admin_get_events(p_admin_id uuid)
RETURNS TABLE (
  event_id          uuid,
  permission_level  text,
  permission_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM public.admin_profiles
  WHERE id = p_admin_id AND is_active = true;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN QUERY
      SELECT e.id, 'manage'::text, 'super_admin'::text
      FROM public.events e;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT DISTINCT ce.event_id, acp.permission_level, 'calendar'::text
    FROM public.admin_calendar_permissions acp
    JOIN public.calendars_events ce ON ce.calendar_id = acp.calendar_id
    WHERE acp.admin_id = p_admin_id
      AND acp.is_active = true
      AND (acp.expires_at IS NULL OR acp.expires_at > now());
END;
$$;

COMMENT ON FUNCTION public.admin_get_events(uuid)
  IS 'Events the given admin can access, derived from calendar permissions joined via calendars_events. Super admins see all events.';

GRANT EXECUTE ON FUNCTION public.admin_get_events(uuid) TO authenticated, service_role, anon;

-- ---------------------------------------------------------------------
-- 3. get_calendar_members_counts(p_calendar_ids uuid[])
-- ---------------------------------------------------------------------
-- Batch version of the existing get_calendar_members_count(uuid).
-- Reuses that function per id so behaviour stays consistent with the
-- dynamic membership rules defined in 006_fix_members_dynamic_function.
CREATE OR REPLACE FUNCTION public.get_calendar_members_counts(p_calendar_ids uuid[])
RETURNS TABLE (
  calendar_id  uuid,
  member_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    public.get_calendar_members_count(c.id)
  FROM public.calendars c
  WHERE c.id = ANY(p_calendar_ids);
$$;

COMMENT ON FUNCTION public.get_calendar_members_counts(uuid[])
  IS 'Batch member counts for a set of calendars. Delegates to get_calendar_members_count per id.';

GRANT EXECUTE ON FUNCTION public.get_calendar_members_counts(uuid[]) TO authenticated, service_role, anon;
