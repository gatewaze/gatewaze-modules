-- ==========================================================================
-- Dynamic calendar members query
-- Combines direct calendar members with people profile data
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.get_calendar_members_dynamic(
  p_calendar_id UUID,
  p_membership_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  calendar_id UUID,
  person_id UUID,
  email TEXT,
  people_profile_id UUID,
  membership_type TEXT,
  membership_status TEXT,
  source TEXT,
  source_type TEXT,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  job_title TEXT,
  avatar_url TEXT,
  luma_user_id TEXT,
  joined_at TIMESTAMPTZ,
  event_count BIGINT
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    cm.id,
    cm.calendar_id,
    cm.person_id,
    COALESCE(cm.email, pp.email)::TEXT AS email,
    cm.people_profile_id,
    cm.membership_type::TEXT,
    cm.membership_status::TEXT,
    cm.import_source::TEXT AS source,
    'direct'::TEXT AS source_type,
    pp.first_name::TEXT,
    pp.last_name::TEXT,
    pp.company::TEXT,
    pp.job_title::TEXT,
    pp.avatar_url::TEXT,
    cm.luma_user_id::TEXT,
    cm.joined_at,
    COALESCE(
      (SELECT COUNT(*) FROM public.registrations r
       WHERE r.person_id = cm.person_id
       AND r.event_id IN (SELECT ce.event_id FROM public.calendars_events ce WHERE ce.calendar_id = p_calendar_id)),
      0
    ) AS event_count
  FROM public.calendars_members cm
  LEFT JOIN public.people_profiles pp ON pp.id = cm.people_profile_id
  WHERE cm.calendar_id = p_calendar_id
    AND (p_membership_type IS NULL OR cm.membership_type = p_membership_type)
    AND (p_search IS NULL OR p_search = '' OR
         cm.email ILIKE '%' || p_search || '%' OR
         pp.first_name ILIKE '%' || p_search || '%' OR
         pp.last_name ILIKE '%' || p_search || '%' OR
         pp.company ILIKE '%' || p_search || '%')
  ORDER BY cm.joined_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_calendar_members_dynamic(UUID, TEXT, TEXT, INTEGER, INTEGER)
  IS 'Get calendar members with profile data, filtering, search, and pagination';

-- ==========================================================================
-- Calendar members count
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.get_calendar_members_count(p_calendar_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE
  member_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO member_count
  FROM public.calendars_members
  WHERE calendar_id = p_calendar_id
    AND membership_status = 'active';

  RETURN member_count;
END;
$$;

COMMENT ON FUNCTION public.get_calendar_members_count(UUID)
  IS 'Count active members in a calendar';
