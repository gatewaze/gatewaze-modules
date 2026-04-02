-- ============================================================================
-- Migration: 002_events_rls_functions
-- Description: RLS policies, RPC functions, views, and realtime config for
--              the core events tables. Previously in core migrations 00006–00015,
--              now owned by the core-events module.
-- ============================================================================

-- ==========================================================================
-- 1. Admin Event Permissions table
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.admin_event_permissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         uuid NOT NULL REFERENCES public.admin_profiles(id) ON DELETE CASCADE,
  event_id         varchar(10) NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  permission_level text CHECK (permission_level IN ('view', 'edit', 'manage')) DEFAULT 'view',
  granted_by       uuid REFERENCES public.admin_profiles(id),
  granted_at       timestamptz DEFAULT now(),
  expires_at       timestamptz,
  is_active        boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE(admin_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_event_permissions_admin ON public.admin_event_permissions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_event_permissions_event ON public.admin_event_permissions(event_id);

COMMENT ON TABLE public.admin_event_permissions IS 'Event-level admin permissions';

CREATE TRIGGER admin_event_permissions_updated_at
  BEFORE UPDATE ON public.admin_event_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. FK from events.account_id -> accounts.id
-- ==========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'events_account_id_fkey'
      AND table_name = 'events'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ==========================================================================
-- 3. Override core stub functions with full event-aware implementations
-- ==========================================================================

-- can_admin_event: Check if current user has event-level admin access
CREATE OR REPLACE FUNCTION public.can_admin_event(p_event_uuid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.admin_event_permissions aep
      JOIN public.admin_profiles ap ON ap.id = aep.admin_id
      JOIN public.events e ON e.event_id = aep.event_id
      WHERE e.id = p_event_uuid
        AND ap.user_id = auth.uid()
        AND ap.is_active = true
        AND aep.is_active = true
        AND (aep.expires_at IS NULL OR aep.expires_at > now())
    );
$$;

-- can_admin_event_by_eid: Same but takes varchar event_id
CREATE OR REPLACE FUNCTION public.can_admin_event_by_eid(p_event_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT public.can_admin_event(e.id)
  FROM public.events e
  WHERE e.event_id = p_event_id;
$$;

-- can_admin_member: Override to also check event registrations
CREATE OR REPLACE FUNCTION public.can_admin_member(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.people_profiles pp
      JOIN public.people p ON p.id = pp.person_id
      JOIN public.events_registrations er ON er.person_id = p.id
      WHERE pp.id = p_profile_id
        AND public.can_admin_event(er.event_id)
    );
$$;

-- ==========================================================================
-- 4. Enable RLS on event tables
-- ==========================================================================

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_event_permissions ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- 5. RLS Policies — admin_event_permissions
-- ==========================================================================

CREATE POLICY "admin_event_permissions_select"
  ON public.admin_event_permissions FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY "admin_event_permissions_insert"
  ON public.admin_event_permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY "admin_event_permissions_update"
  ON public.admin_event_permissions FOR UPDATE TO authenticated
  USING (public.is_super_admin());

CREATE POLICY "admin_event_permissions_delete"
  ON public.admin_event_permissions FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ==========================================================================
-- 6. RLS Policies — events
-- ==========================================================================

CREATE POLICY "events_select_public"
  ON public.events FOR SELECT TO anon
  USING (true);

CREATE POLICY "events_select_admin"
  ON public.events FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "events_insert_admin"
  ON public.events FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY "events_update_admin"
  ON public.events FOR UPDATE TO authenticated
  USING (public.can_admin_event(id));

CREATE POLICY "events_delete_admin"
  ON public.events FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ==========================================================================
-- 7. RLS Policies — events_registrations
-- ==========================================================================

CREATE POLICY "registrations_select_own"
  ON public.events_registrations FOR SELECT TO authenticated
  USING (
    person_id = (
      SELECT c.id FROM public.people c
      WHERE c.auth_user_id = auth.uid()
    )
    OR public.can_admin_event(event_id)
  );

CREATE POLICY "registrations_insert_self"
  ON public.events_registrations FOR INSERT TO authenticated
  WITH CHECK (
    person_id = (
      SELECT c.id FROM public.people c
      WHERE c.auth_user_id = auth.uid()
    )
  );

CREATE POLICY "registrations_insert_admin"
  ON public.events_registrations FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "registrations_update_admin"
  ON public.events_registrations FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "registrations_delete_admin"
  ON public.events_registrations FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ==========================================================================
-- 8. RLS Policies — events_attendance
-- ==========================================================================

CREATE POLICY "attendance_select"
  ON public.events_attendance FOR SELECT TO authenticated
  USING (
    person_id = (
      SELECT c.id FROM public.people c
      WHERE c.auth_user_id = auth.uid()
    )
    OR public.can_admin_event(event_id)
  );

CREATE POLICY "attendance_insert"
  ON public.events_attendance FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "attendance_update"
  ON public.events_attendance FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "attendance_delete"
  ON public.events_attendance FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));

-- ==========================================================================
-- 9. RPC Functions
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.events_get_registration_count(p_event_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT count(*)
  FROM public.events_registrations
  WHERE event_id = p_event_id
    AND status NOT IN ('cancelled');
$$;

COMMENT ON FUNCTION public.events_get_registration_count(uuid)
  IS 'Count non-cancelled registrations for an event';

CREATE OR REPLACE FUNCTION public.events_get_registration_stats(p_event_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total',      COUNT(*)::int,
    'confirmed',  COUNT(*) FILTER (WHERE r.status = 'confirmed')::int,
    'pending',    COUNT(*) FILTER (WHERE r.status = 'pending')::int,
    'cancelled',  COUNT(*) FILTER (WHERE r.status = 'cancelled')::int,
    'waitlisted', COUNT(*) FILTER (WHERE r.status = 'waitlisted')::int,
    'checked_in', COUNT(*) FILTER (WHERE r.checked_in = true)::int
  )
  FROM public.events_registrations r
  JOIN public.events e ON e.id = r.event_id
  WHERE e.event_id = p_event_id;
$$;

COMMENT ON FUNCTION public.events_get_registration_stats(text)
  IS 'Aggregate registration status breakdown for an event';

CREATE OR REPLACE FUNCTION public.events_get_attendance_stats(p_event_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total',      COUNT(*)::int,
    'checked_in', COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL)::int
  )
  FROM public.events_attendance a
  JOIN public.events e ON e.id = a.event_id
  WHERE e.event_id = p_event_id;
$$;

COMMENT ON FUNCTION public.events_get_attendance_stats(text)
  IS 'Aggregate attendance stats (check-ins) for an event';

CREATE OR REPLACE FUNCTION public.admin_has_event_permission(
  event_id_param   text,
  permission_param text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_admin_id uuid;
  v_role     text;
BEGIN
  SELECT ap.id, ap.role
  INTO v_admin_id, v_role
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid()
    AND ap.is_active = true;

  IF v_admin_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.admin_event_permissions
    WHERE admin_id = v_admin_id
      AND event_id = event_id_param
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.admin_has_event_permission(text, text)
  IS 'Check whether the current user has a specific permission for an event';

CREATE OR REPLACE FUNCTION public.admin_get_events_permissions(
  event_ids            text[],
  permissions_to_check text[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_result      jsonb := '{}'::jsonb;
  v_event_id    text;
  v_perm        text;
  v_event_perms jsonb;
BEGIN
  FOREACH v_event_id IN ARRAY event_ids LOOP
    v_event_perms := '{}'::jsonb;
    FOREACH v_perm IN ARRAY permissions_to_check LOOP
      v_event_perms := v_event_perms || jsonb_build_object(
        v_perm,
        public.admin_has_event_permission(v_event_id, v_perm)
      );
    END LOOP;
    v_result := v_result || jsonb_build_object(v_event_id, v_event_perms);
  END LOOP;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.admin_get_events_permissions(text[], text[])
  IS 'Batch-check permissions across multiple events for the current user';

CREATE OR REPLACE FUNCTION public.admin_get_my_assigned_events()
RETURNS TABLE(
  event_id          text,
  event_title       text,
  event_start       timestamptz,
  permission_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_admin_id uuid;
  v_role     text;
BEGIN
  SELECT ap.id, ap.role
  INTO v_admin_id, v_role
  FROM public.admin_profiles ap
  WHERE ap.user_id = auth.uid()
    AND ap.is_active = true;

  IF v_admin_id IS NULL THEN
    RETURN;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN QUERY
      SELECT e.event_id, e.event_title::text, e.event_start, 'super_admin'::text
      FROM public.events e
      ORDER BY e.event_start DESC NULLS LAST;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT DISTINCT ON (e.event_id)
      e.event_id,
      e.event_title::text,
      e.event_start,
      'direct'::text
    FROM public.events e
    JOIN public.admin_event_permissions aep ON aep.event_id = e.event_id
    WHERE aep.admin_id = v_admin_id
      AND aep.is_active = true
      AND (aep.expires_at IS NULL OR aep.expires_at > now())
    ORDER BY e.event_id, e.event_start DESC NULLS LAST;
END;
$$;

COMMENT ON FUNCTION public.admin_get_my_assigned_events()
  IS 'List events the current admin has been assigned to (super_admins see all)';

-- Screenshot RPC
CREATE OR REPLACE FUNCTION public.events_update_screenshot_status(
    p_event_id varchar,
    p_screenshot_generated boolean,
    p_screenshot_url text DEFAULT NULL,
    p_screenshot_generated_at timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.events SET
        screenshot_generated = p_screenshot_generated,
        screenshot_url = p_screenshot_url,
        screenshot_generated_at = p_screenshot_generated_at,
        updated_at = NOW()
    WHERE event_id = p_event_id;

    RETURN FOUND;
END;
$$;

-- ==========================================================================
-- 10. Views
-- ==========================================================================

CREATE OR REPLACE VIEW public.events_registrations_with_people AS
SELECT
  r.*,
  p.email,
  p.attributes->>'first_name'   AS first_name,
  p.attributes->>'last_name'    AS last_name,
  COALESCE(
    NULLIF(TRIM(COALESCE(p.attributes->>'first_name', '') || ' ' || COALESCE(p.attributes->>'last_name', '')), ''),
    p.attributes->>'first_name'
  ) AS full_name,
  p.attributes->>'company'      AS company,
  p.attributes->>'job_title'    AS job_title,
  p.attributes->>'linkedin_url' AS linkedin_url,
  p.avatar_url,
  p.phone,
  p.attributes->>'location'     AS location,
  p.cio_id,
  p.attributes AS people_attributes
FROM public.events_registrations r
LEFT JOIN public.people p ON p.id = r.person_id;

-- ==========================================================================
-- 11. Realtime Publications
-- ==========================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE events_registrations;
ALTER PUBLICATION supabase_realtime ADD TABLE events_attendance;

ALTER TABLE events_registrations REPLICA IDENTITY FULL;
ALTER TABLE events_attendance REPLICA IDENTITY FULL;
