-- ============================================================================
-- Module: calendars
-- Migration: 005_calendar_email_groups
-- Description: Calendar-based email groups. Each calendar gets an address
--              of the form {slug}@{EMAIL_FROM_DOMAIN}. Inbound mail to this
--              address forwards to all calendar admins; outbound blasts and
--              signup emails appear to come from this address so replies
--              loop back through the group.
-- ============================================================================

-- ==========================================================================
-- 1. calendars.settings.email_group_enabled — opt-out switch (default true)
--    No schema change needed — settings is already a jsonb column.
--    Documented here as the canonical key.
-- ==========================================================================
COMMENT ON COLUMN public.calendars.settings IS
  'Per-calendar jsonb settings. Well-known keys: location, organiser_bio, '
  'social_links, microsite_enabled, email_group_enabled (default true — '
  'set to false to disable the {slug}@domain group address).';

-- ==========================================================================
-- 2. calendar_email_forwards — audit log of inbound forwarded messages
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendar_email_forwards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id     uuid REFERENCES public.calendars(id) ON DELETE SET NULL,
  to_address      text NOT NULL,           -- the {slug}@domain address hit
  from_address    text NOT NULL,           -- original sender
  from_name       text,
  subject         text,
  message_id      text,                    -- original Message-ID header
  recipient_count integer NOT NULL DEFAULT 0,
  recipients      text[] DEFAULT '{}',     -- admin emails forwarded to
  status          text NOT NULL DEFAULT 'forwarded'
    CHECK (status IN ('forwarded','no_calendar','no_admins','disabled','rejected','failed')),
  error_message   text,
  raw_size_bytes  integer,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_email_forwards_calendar
  ON public.calendar_email_forwards (calendar_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_email_forwards_from
  ON public.calendar_email_forwards (from_address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_email_forwards_status
  ON public.calendar_email_forwards (status, received_at DESC);

COMMENT ON TABLE public.calendar_email_forwards IS
  'Audit log of inbound emails received at {calendar-slug}@domain and '
  'forwarded to calendar admins. Populated by the calendars-inbound-email '
  'edge function which receives SendGrid Inbound Parse webhooks.';

ALTER TABLE public.calendar_email_forwards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_email_forwards_admin_select ON public.calendar_email_forwards;
CREATE POLICY calendar_email_forwards_admin_select ON public.calendar_email_forwards
  FOR SELECT USING (
    public.is_super_admin()
    OR (calendar_id IS NOT NULL AND public.can_admin_calendar(calendar_id))
  );

-- ==========================================================================
-- 3. get_calendar_admin_emails() — resolve the admin email list for a calendar
--
--    Used by the inbound forwarding function. Returns distinct emails for
--    every admin_profiles row with an active, non-expired
--    admin_calendar_permissions entry for the given calendar.
--
--    admin_profiles stores email directly; if a schema variant uses
--    people(id) via a user_id link, we also fall back to people.email
--    joined on admin_profiles.user_id = people.auth_user_id.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_calendar_admin_emails(p_calendar_id uuid)
RETURNS TABLE (admin_id uuid, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    ap.id AS admin_id,
    COALESCE(ap.email, p.email) AS email
  FROM public.admin_calendar_permissions acp
  JOIN public.admin_profiles ap ON ap.id = acp.admin_id
  LEFT JOIN public.people p ON p.auth_user_id = ap.user_id
  WHERE acp.calendar_id = p_calendar_id
    AND acp.is_active = true
    AND (acp.expires_at IS NULL OR acp.expires_at > now())
    AND ap.is_active = true
    AND COALESCE(ap.email, p.email) IS NOT NULL;
$$;

COMMENT ON FUNCTION public.get_calendar_admin_emails(uuid) IS
  'Returns the distinct email list for a calendar''s active admins. Used by '
  'the inbound email forwarding function to fan out to recipients.';

-- ==========================================================================
-- 4. resolve_calendar_by_slug_or_id() — helper for the inbound parser
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.resolve_calendar_by_slug_or_id(p_identifier text)
RETURNS TABLE (id uuid, name text, slug text, calendar_id text, settings jsonb, is_active boolean)
LANGUAGE sql
STABLE
AS $$
  SELECT id, name, slug, calendar_id, settings, is_active
  FROM public.calendars
  WHERE (slug = p_identifier OR calendar_id = p_identifier)
  LIMIT 1;
$$;
