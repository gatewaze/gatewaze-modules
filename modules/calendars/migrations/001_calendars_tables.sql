-- ============================================================================
-- Module: calendars
-- Migration: 001_calendars_tables
-- Description: Calendars, calendar-event junction, calendar members, scraper-calendar
--              junction, admin calendar/event permissions, calendar invites,
--              calendar interactions, calendar preferences, and helper functions
-- ============================================================================

-- ==========================================================================
-- 1. Calendars
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id          text UNIQUE,
  name                 text NOT NULL,
  slug                 text UNIQUE NOT NULL,
  description          text,
  image_url            text,
  logo_url             text,
  cover_image_url      text,
  color                varchar(7),
  is_public            boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  visibility           text CHECK (visibility IN ('public', 'private', 'unlisted')) DEFAULT 'private',
  external_url         text,
  luma_calendar_id     text,
  account_id           uuid,
  default_scraper_id   integer,
  created_by_admin_id  uuid,
  settings             jsonb DEFAULT '{}'::jsonb,
  metadata             jsonb DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.calendars IS 'Curated event calendars';

CREATE INDEX IF NOT EXISTS idx_calendars_luma    ON public.calendars(luma_calendar_id) WHERE luma_calendar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendars_account ON public.calendars(account_id);

CREATE TRIGGER calendars_updated_at
  BEFORE UPDATE ON public.calendars
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- Auto-generate calendar_id (CAL-XXXXXXXX) when not provided
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.generate_calendar_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.calendar_id IS NULL OR NEW.calendar_id = '' THEN
    NEW.calendar_id := 'CAL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calendars_generate_calendar_id
  BEFORE INSERT ON public.calendars
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_calendar_id();

-- ==========================================================================
-- 2. Junction: calendar <-> event
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_events (
  calendar_id       uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  id                uuid DEFAULT gen_random_uuid(),
  sort_order        integer DEFAULT 0,
  is_featured       boolean DEFAULT false,
  added_via         text CHECK (added_via IN ('manual', 'scraper', 'import', 'api')) DEFAULT 'manual',
  added_by_admin_id uuid,
  added_at          timestamptz DEFAULT now(),
  PRIMARY KEY (calendar_id, event_id)
);

COMMENT ON TABLE public.calendars_events IS 'Links events to calendars';

-- ==========================================================================
-- 3. Calendar members
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
  person_id uuid REFERENCES public.people(id) ON DELETE CASCADE,
  email varchar(255),
  people_profile_id uuid REFERENCES public.people_profiles(id) ON DELETE SET NULL,
  membership_type text CHECK (membership_type IN (
    'subscriber', 'member', 'vip', 'organizer', 'admin'
  )) DEFAULT 'subscriber',
  membership_status text CHECK (membership_status IN (
    'active', 'pending', 'inactive', 'blocked'
  )) DEFAULT 'active',
  email_notifications boolean DEFAULT true,
  push_notifications boolean DEFAULT false,
  import_source text,
  luma_user_id text,
  luma_revenue text,
  luma_event_approved_count integer DEFAULT 0,
  luma_event_checked_in_count integer DEFAULT 0,
  luma_membership_name text,
  luma_membership_status text,
  luma_tags text[],
  import_metadata jsonb DEFAULT '{}'::jsonb,
  first_seen_at timestamptz,
  joined_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT calendars_members_identity_check CHECK (
    person_id IS NOT NULL OR email IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_members_unique_customer
  ON public.calendars_members(calendar_id, person_id) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_members_unique_email
  ON public.calendars_members(calendar_id, email) WHERE email IS NOT NULL AND person_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendars_members_calendar ON public.calendars_members(calendar_id);
CREATE INDEX IF NOT EXISTS idx_calendars_members_customer ON public.calendars_members(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendars_members_email ON public.calendars_members(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendars_members_status ON public.calendars_members(calendar_id, membership_status);

COMMENT ON TABLE public.calendars_members IS 'Tracks who is subscribed/following each calendar';

CREATE TRIGGER calendars_members_updated_at
  BEFORE UPDATE ON public.calendars_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 4. Scraper-calendar junction
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.scrapers_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scraper_id integer NOT NULL REFERENCES public.scrapers(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
  is_active boolean DEFAULT true,
  auto_add_events boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(scraper_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_scrapers_calendars_scraper ON public.scrapers_calendars(scraper_id);
CREATE INDEX IF NOT EXISTS idx_scrapers_calendars_calendar ON public.scrapers_calendars(calendar_id);

COMMENT ON TABLE public.scrapers_calendars IS 'Allows scrapers to feed events into multiple calendars';

-- ==========================================================================
-- 5. Admin calendar permissions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.admin_calendar_permissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         uuid NOT NULL REFERENCES public.admin_profiles(id) ON DELETE CASCADE,
  calendar_id      uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
  permission_level text CHECK (permission_level IN ('view', 'edit', 'manage')) DEFAULT 'view',
  granted_by       uuid REFERENCES public.admin_profiles(id),
  granted_at       timestamptz DEFAULT now(),
  expires_at       timestamptz,
  is_active        boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE(admin_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_calendar_permissions_admin ON public.admin_calendar_permissions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_calendar_permissions_calendar ON public.admin_calendar_permissions(calendar_id);

COMMENT ON TABLE public.admin_calendar_permissions IS 'Calendar-level admin permissions';

CREATE TRIGGER admin_calendar_permissions_updated_at
  BEFORE UPDATE ON public.admin_calendar_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 6. Admin event permissions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.admin_event_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.admin_profiles(id) ON DELETE CASCADE,
  event_id varchar(10) NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  permission_level text CHECK (permission_level IN ('view', 'edit', 'manage')) DEFAULT 'view',
  granted_by uuid REFERENCES public.admin_profiles(id),
  granted_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(admin_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_event_permissions_admin ON public.admin_event_permissions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_event_permissions_event ON public.admin_event_permissions(event_id);

COMMENT ON TABLE public.admin_event_permissions IS 'Event-level admin permissions';

CREATE TRIGGER admin_event_permissions_updated_at
  BEFORE UPDATE ON public.admin_event_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 7. Calendar invites
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id varchar REFERENCES public.events(event_id) ON DELETE CASCADE,
  registration_id uuid REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  people_profile_id uuid REFERENCES public.people_profiles(id),
  token varchar(64) UNIQUE NOT NULL,
  expires_at timestamptz,
  total_clicks integer DEFAULT 0,
  last_clicked_at timestamptz,
  google_calendar_clicks integer DEFAULT 0,
  outlook_calendar_clicks integer DEFAULT 0,
  apple_calendar_clicks integer DEFAULT 0,
  ics_download_clicks integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT valid_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_calendars_invites_token ON public.calendars_invites(token);
CREATE INDEX IF NOT EXISTS idx_calendars_invites_event ON public.calendars_invites(event_id);

CREATE TRIGGER calendars_invites_updated_at
  BEFORE UPDATE ON public.calendars_invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 8. Calendar interactions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_interactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  invite_id uuid REFERENCES public.calendars_invites(id) ON DELETE CASCADE,
  interaction_type varchar(50) NOT NULL,
  ip_address inet,
  user_agent text,
  referer text,
  calendar_client varchar(100),
  device_type varchar(50),
  browser varchar(50),
  os varchar(50),
  country varchar(2),
  city varchar(100),
  response_time_ms integer,
  success boolean DEFAULT true,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendars_interactions_invite ON public.calendars_interactions(invite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendars_interactions_type ON public.calendars_interactions(interaction_type, created_at DESC);

-- ==========================================================================
-- 9. Calendar preferences
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_preferences (
  people_profile_id uuid REFERENCES public.people_profiles(id) PRIMARY KEY,
  preferred_calendar varchar(50),
  timezone varchar(50),
  reminder_minutes integer DEFAULT 15,
  include_description boolean DEFAULT true,
  include_location boolean DEFAULT true,
  include_organizer boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TRIGGER calendars_preferences_updated_at
  BEFORE UPDATE ON public.calendars_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 10. Permission check helper functions
-- ==========================================================================

-- can_admin_calendar: Check if current user has calendar-level admin access
CREATE OR REPLACE FUNCTION public.can_admin_calendar(p_calendar_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.admin_calendar_permissions acp
      JOIN public.admin_profiles ap ON ap.id = acp.admin_id
      WHERE acp.calendar_id = p_calendar_id
        AND ap.user_id = auth.uid()
        AND ap.is_active = true
        AND acp.is_active = true
        AND (acp.expires_at IS NULL OR acp.expires_at > now())
    );
$$;

COMMENT ON FUNCTION public.can_admin_calendar(uuid)
  IS 'Check if current user has admin access to a calendar';

-- can_admin_event: Check if current user has event-level admin access
-- (direct event permission OR via calendar that contains this event)
-- Takes events.id (uuid)
CREATE OR REPLACE FUNCTION public.can_admin_event(p_event_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.admin_event_permissions aep
      JOIN public.admin_profiles ap ON ap.id = aep.admin_id
      JOIN public.events e ON e.event_id = aep.event_id
      WHERE e.id = p_event_uuid AND ap.user_id = auth.uid() AND ap.is_active = true AND aep.is_active = true AND (aep.expires_at IS NULL OR aep.expires_at > now())
    )
    OR EXISTS (
      SELECT 1 FROM public.admin_calendar_permissions acp
      JOIN public.admin_profiles ap ON ap.id = acp.admin_id
      JOIN public.calendars_events ce ON ce.calendar_id = acp.calendar_id
      WHERE ce.event_id = p_event_uuid AND ap.user_id = auth.uid() AND ap.is_active = true AND acp.is_active = true AND (acp.expires_at IS NULL OR acp.expires_at > now())
    );
$$;

COMMENT ON FUNCTION public.can_admin_event(uuid)
  IS 'Check if current user has admin access to an event (direct or via calendar)';

-- can_admin_event_by_eid: Same but takes events.event_id (varchar)
CREATE OR REPLACE FUNCTION public.can_admin_event_by_eid(p_event_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT public.can_admin_event(e.id)
  FROM public.events e
  WHERE e.event_id = p_event_id;
$$;

-- can_access_calendar: Check if an admin (by ID) can access a calendar
CREATE OR REPLACE FUNCTION public.can_access_calendar(p_admin_id uuid, p_calendar_id uuid)
RETURNS boolean AS $$
DECLARE
  v_is_super_admin boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.admin_profiles
    WHERE id = p_admin_id AND role = 'super_admin' AND is_active = true
  ) INTO v_is_super_admin;

  IF v_is_super_admin THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.admin_calendar_permissions
    WHERE admin_id = p_admin_id AND calendar_id = p_calendar_id
      AND is_active = true AND (expires_at IS NULL OR expires_at > now())
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- can_access_event: Check if an admin (by ID) can access an event
CREATE OR REPLACE FUNCTION public.can_access_event(p_admin_id uuid, p_event_id varchar)
RETURNS boolean AS $$
DECLARE
  v_is_super_admin boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.admin_profiles
    WHERE id = p_admin_id AND role = 'super_admin' AND is_active = true
  ) INTO v_is_super_admin;

  IF v_is_super_admin THEN RETURN true; END IF;

  IF EXISTS (
    SELECT 1 FROM public.admin_event_permissions
    WHERE admin_id = p_admin_id AND event_id = p_event_id
      AND is_active = true AND (expires_at IS NULL OR expires_at > now())
  ) THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.admin_calendar_permissions acp
    JOIN public.calendars_events ce ON ce.calendar_id = acp.calendar_id
    JOIN public.events ev ON ev.id = ce.event_id
    WHERE acp.admin_id = p_admin_id AND ev.event_id = p_event_id
      AND acp.is_active = true AND (acp.expires_at IS NULL OR acp.expires_at > now())
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- get_admin_calendars: List calendars an admin can access
CREATE OR REPLACE FUNCTION public.get_admin_calendars(p_admin_id uuid)
RETURNS TABLE (calendar_id uuid, permission_level text) AS $$
DECLARE
  v_is_super_admin boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.admin_profiles
    WHERE id = p_admin_id AND role = 'super_admin' AND is_active = true
  ) INTO v_is_super_admin;

  IF v_is_super_admin THEN
    RETURN QUERY SELECT c.id, 'manage'::text FROM public.calendars c WHERE c.is_active = true;
  ELSE
    RETURN QUERY
    SELECT acp.calendar_id, acp.permission_level
    FROM public.admin_calendar_permissions acp
    WHERE acp.admin_id = p_admin_id AND acp.is_active = true
      AND (acp.expires_at IS NULL OR acp.expires_at > now());
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- get_admin_events: List events an admin can access
CREATE OR REPLACE FUNCTION public.get_admin_events(p_admin_id uuid)
RETURNS TABLE (event_id varchar, permission_level text, permission_source text) AS $$
DECLARE
  v_is_super_admin boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.admin_profiles
    WHERE id = p_admin_id AND role = 'super_admin' AND is_active = true
  ) INTO v_is_super_admin;

  IF v_is_super_admin THEN
    RETURN QUERY SELECT e.event_id, 'manage'::text, 'super_admin'::text FROM public.events e;
  ELSE
    RETURN QUERY
    SELECT aep.event_id, aep.permission_level, 'direct'::text
    FROM public.admin_event_permissions aep
    WHERE aep.admin_id = p_admin_id AND aep.is_active = true
      AND (aep.expires_at IS NULL OR aep.expires_at > now())
    UNION
    SELECT ev.event_id, acp.permission_level, 'calendar'::text
    FROM public.admin_calendar_permissions acp
    JOIN public.calendars_events ce ON ce.calendar_id = acp.calendar_id
    JOIN public.events ev ON ev.id = ce.event_id
    WHERE acp.admin_id = p_admin_id AND acp.is_active = true
      AND (acp.expires_at IS NULL OR acp.expires_at > now())
      AND ev.event_id NOT IN (
        SELECT aep2.event_id FROM public.admin_event_permissions aep2
        WHERE aep2.admin_id = p_admin_id AND aep2.is_active = true
      );
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- get_calendar_stats: Summary stats for a calendar
CREATE OR REPLACE FUNCTION public.get_calendar_stats(p_calendar_id uuid)
RETURNS json AS $$
SELECT json_build_object(
  'total_members', (SELECT COUNT(*)::int FROM public.calendars_members WHERE calendar_id = p_calendar_id AND membership_status = 'active'),
  'total_events', (SELECT COUNT(*)::int FROM public.calendars_events WHERE calendar_id = p_calendar_id),
  'upcoming_events', (SELECT COUNT(*)::int FROM public.calendars_events ce JOIN public.events e ON e.id = ce.event_id WHERE ce.calendar_id = p_calendar_id AND e.event_start > now()),
  'past_events', (SELECT COUNT(*)::int FROM public.calendars_events ce JOIN public.events e ON e.id = ce.event_id WHERE ce.calendar_id = p_calendar_id AND e.event_end < now())
);
$$ LANGUAGE sql STABLE;

-- calendars_get_event_count: Count events in a calendar
CREATE OR REPLACE FUNCTION public.calendars_get_event_count(
  p_calendar_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT count(*)
  FROM public.calendars_events
  WHERE calendar_id = p_calendar_id;
$$;

COMMENT ON FUNCTION public.calendars_get_event_count(uuid)
  IS 'Count the number of events in a calendar';

-- ==========================================================================
-- 11. RLS
-- ==========================================================================
ALTER TABLE public.calendars_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrapers_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_calendar_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_event_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendars_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendars_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendars_preferences ENABLE ROW LEVEL SECURITY;

-- ---- calendars_events ----
DROP POLICY IF EXISTS "calendar_events_select_admin" ON public.calendars_events;
DROP POLICY IF EXISTS "calendar_events_insert_admin" ON public.calendars_events;
DROP POLICY IF EXISTS "calendar_events_update_admin" ON public.calendars_events;
DROP POLICY IF EXISTS "calendar_events_delete_admin" ON public.calendars_events;

CREATE POLICY "calendar_events_select_admin"
  ON public.calendars_events FOR SELECT TO authenticated
  USING (public.can_admin_calendar(calendar_id));

CREATE POLICY "calendar_events_insert_admin"
  ON public.calendars_events FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_calendar(calendar_id));

CREATE POLICY "calendar_events_update_admin"
  ON public.calendars_events FOR UPDATE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

CREATE POLICY "calendar_events_delete_admin"
  ON public.calendars_events FOR DELETE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

-- ---- calendars_members ----
DROP POLICY IF EXISTS "auth_all_calendars_members" ON public.calendars_members;
DROP POLICY IF EXISTS "auth_all_calendar_members" ON public.calendars_members;

CREATE POLICY "calendar_members_select"
  ON public.calendars_members FOR SELECT TO authenticated
  USING (
    public.is_own_people_profile(people_profile_id)
    OR public.can_admin_calendar(calendar_id)
  );

CREATE POLICY "calendar_members_insert"
  ON public.calendars_members FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_calendar(calendar_id));

CREATE POLICY "calendar_members_update"
  ON public.calendars_members FOR UPDATE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

CREATE POLICY "calendar_members_delete"
  ON public.calendars_members FOR DELETE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

-- ---- scrapers_calendars ----
DROP POLICY IF EXISTS "auth_all_scrapers_calendars" ON public.scrapers_calendars;
DROP POLICY IF EXISTS "auth_all_scraper_calendars" ON public.scrapers_calendars;

CREATE POLICY "scraper_calendars_select"
  ON public.scrapers_calendars FOR SELECT TO authenticated
  USING (public.can_admin_calendar(calendar_id));

CREATE POLICY "scraper_calendars_insert"
  ON public.scrapers_calendars FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_calendar(calendar_id));

CREATE POLICY "scraper_calendars_update"
  ON public.scrapers_calendars FOR UPDATE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

CREATE POLICY "scraper_calendars_delete"
  ON public.scrapers_calendars FOR DELETE TO authenticated
  USING (public.can_admin_calendar(calendar_id));

-- ---- admin_calendar_permissions ----
DROP POLICY IF EXISTS "auth_all_admin_calendar_permissions" ON public.admin_calendar_permissions;

CREATE POLICY "admin_calendar_permissions_select"
  ON public.admin_calendar_permissions FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY "admin_calendar_permissions_insert"
  ON public.admin_calendar_permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY "admin_calendar_permissions_update"
  ON public.admin_calendar_permissions FOR UPDATE TO authenticated
  USING (public.is_super_admin());

CREATE POLICY "admin_calendar_permissions_delete"
  ON public.admin_calendar_permissions FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ---- admin_event_permissions ----
DROP POLICY IF EXISTS "auth_all_admin_event_permissions" ON public.admin_event_permissions;

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

-- ---- calendars_invites ----
DROP POLICY IF EXISTS "auth_all_calendars_invites" ON public.calendars_invites;
DROP POLICY IF EXISTS "auth_all_calendar_invites" ON public.calendars_invites;

CREATE POLICY "calendar_invites_select"
  ON public.calendars_invites FOR SELECT TO authenticated
  USING (
    people_profile_id IN (SELECT pp.id FROM public.people_profiles pp JOIN public.people p ON p.id = pp.person_id WHERE p.auth_user_id = auth.uid())
    OR public.is_admin()
  );

CREATE POLICY "calendar_invites_insert"
  ON public.calendars_invites FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "calendar_invites_update"
  ON public.calendars_invites FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "calendar_invites_delete"
  ON public.calendars_invites FOR DELETE TO authenticated
  USING (public.is_admin());

-- ---- calendars_interactions ----
DROP POLICY IF EXISTS "auth_all_calendars_interactions" ON public.calendars_interactions;
DROP POLICY IF EXISTS "auth_all_calendar_interactions" ON public.calendars_interactions;

CREATE POLICY "calendar_interactions_select"
  ON public.calendars_interactions FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "calendar_interactions_insert"
  ON public.calendars_interactions FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "calendar_interactions_update"
  ON public.calendars_interactions FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "calendar_interactions_delete"
  ON public.calendars_interactions FOR DELETE TO authenticated
  USING (public.is_admin());

-- ---- calendars_preferences ----
DROP POLICY IF EXISTS "auth_all_calendars_preferences" ON public.calendars_preferences;
DROP POLICY IF EXISTS "auth_all_calendar_preferences" ON public.calendars_preferences;

CREATE POLICY "calendar_preferences_select"
  ON public.calendars_preferences FOR SELECT TO authenticated
  USING (
    people_profile_id IN (
      SELECT mp.id FROM public.people_profiles mp
      JOIN public.people c ON c.id = mp.person_id
      WHERE c.auth_user_id = auth.uid()
    )
    OR public.is_admin()
  );

CREATE POLICY "calendar_preferences_insert"
  ON public.calendars_preferences FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "calendar_preferences_update"
  ON public.calendars_preferences FOR UPDATE TO authenticated
  USING (
    people_profile_id IN (
      SELECT mp.id FROM public.people_profiles mp
      JOIN public.people c ON c.id = mp.person_id
      WHERE c.auth_user_id = auth.uid()
    )
    OR public.is_admin()
  );

CREATE POLICY "calendar_preferences_delete"
  ON public.calendars_preferences FOR DELETE TO authenticated
  USING (public.is_admin());
