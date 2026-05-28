-- ============================================================================
-- Module: calendars
-- Migration: 004_calendar_messaging
-- Description: Adds the messaging surface — calendars_blasts table for
--              persisted audience definitions, the resolve_calendar_audience()
--              SQL function as the single source of truth for audience
--              resolution, and the polymorphic source columns on
--              email_batch_jobs (added here because email_batch_jobs lives in
--              bulk-emailing but needs no hard FK to calendars).
--              Per spec-calendars-microsites §7.3, §7.4, §8.3.
-- ============================================================================

-- ==========================================================================
-- 1. email_batch_jobs polymorphic source — soft reference, no FK
--
--    bulk-emailing owns the table, calendars is optional, so we add the
--    columns conditionally. If bulk-emailing isn't installed, we skip
--    silently — the calendars module's blast features won't work but the
--    base module still loads.
-- ==========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'email_batch_jobs') THEN
    -- source_type discriminator
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_batch_jobs' AND column_name = 'source_type'
    ) THEN
      ALTER TABLE public.email_batch_jobs
        ADD COLUMN source_type text NOT NULL DEFAULT 'event'
        CHECK (source_type IN ('event','calendar'));
    END IF;

    -- source_id polymorphic soft reference (no FK constraint)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_batch_jobs' AND column_name = 'source_id'
    ) THEN
      ALTER TABLE public.email_batch_jobs ADD COLUMN source_id uuid;
    END IF;

    -- Index for "history for one source" queries
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_email_batch_jobs_source'
    ) THEN
      CREATE INDEX idx_email_batch_jobs_source
        ON public.email_batch_jobs (source_type, source_id, created_at DESC)
        WHERE source_id IS NOT NULL;
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 2. calendars_blasts — audience definition + delivery linkage
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.calendars_blasts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id        uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
  created_by         uuid NOT NULL,           -- admin_profiles(id), no hard FK
  channel            text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  subject            text,
  body_template      text,
  audience_filter    jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_count    integer NOT NULL DEFAULT 0,
  email_batch_job_id uuid,                    -- soft ref to email_batch_jobs(id)
  sms_job_id         uuid,                    -- soft ref to twilio-sms job
  whatsapp_job_id    uuid,                    -- soft ref to whatsapp job
  status             text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')),
  scheduled_at       timestamptz,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendars_blasts_calendar
  ON public.calendars_blasts (calendar_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendars_blasts_pending
  ON public.calendars_blasts (status, created_at)
  WHERE status IN ('draft','scheduled','sending');

DROP TRIGGER IF EXISTS calendars_blasts_updated_at ON public.calendars_blasts;
CREATE TRIGGER calendars_blasts_updated_at
  BEFORE UPDATE ON public.calendars_blasts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.calendars_blasts IS
  'A blast is a logical send with a persisted audience definition. The actual '
  'delivery jobs live in email_batch_jobs / sms_jobs / whatsapp_jobs and are '
  'referenced by *_job_id soft references. The audience_filter jsonb is the '
  'reproducible definition.';

-- ==========================================================================
-- 3. RLS for calendars_blasts
-- ==========================================================================
ALTER TABLE public.calendars_blasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendars_blasts_admin_select ON public.calendars_blasts;
CREATE POLICY calendars_blasts_admin_select ON public.calendars_blasts
  FOR SELECT
  USING (public.can_admin_calendar(calendar_id));

DROP POLICY IF EXISTS calendars_blasts_admin_insert ON public.calendars_blasts;
CREATE POLICY calendars_blasts_admin_insert ON public.calendars_blasts
  FOR INSERT
  WITH CHECK (public.can_admin_calendar(calendar_id));

DROP POLICY IF EXISTS calendars_blasts_admin_update ON public.calendars_blasts;
CREATE POLICY calendars_blasts_admin_update ON public.calendars_blasts
  FOR UPDATE
  USING (public.can_admin_calendar(calendar_id))
  WITH CHECK (public.can_admin_calendar(calendar_id));

DROP POLICY IF EXISTS calendars_blasts_admin_delete ON public.calendars_blasts;
CREATE POLICY calendars_blasts_admin_delete ON public.calendars_blasts
  FOR DELETE
  USING (public.can_admin_calendar(calendar_id));

-- ==========================================================================
-- 4. resolve_calendar_audience() — SQL helper (single source of truth)
--
--    Filters calendars_members rows by:
--      - membership_status = 'active'
--      - channel prereq (email/sms/whatsapp opt-in)
--      - membership_types (optional subset)
--      - event_participation groups (any_of/all_of/none_of × registered/attended)
--    Returns one row per eligible recipient.
--
--    SECURITY DEFINER so it can read calendars_members from the API layer
--    without exposing the table to anonymous clients.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.resolve_calendar_audience(
  p_calendar_id uuid,
  p_filter      jsonb,
  p_channel     text DEFAULT 'email'
) RETURNS TABLE (
  member_id        uuid,
  person_id        uuid,
  email            text,
  phone            text,
  membership_type  text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership_types text[];
  v_status_filter text[];
  v_require_email boolean;
  v_groups jsonb;
BEGIN
  -- Parse filter values with defaults
  v_membership_types := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p_filter->'membership_types')),
    ARRAY[]::text[]
  );
  v_status_filter := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p_filter->'membership_status')),
    ARRAY['active']::text[]
  );
  v_require_email := COALESCE((p_filter->>'require_email_notifications')::boolean, p_channel = 'email');
  v_groups := COALESCE(p_filter->'event_participation', '[]'::jsonb);

  RETURN QUERY
  WITH base AS (
    SELECT
      cm.id            AS member_id,
      cm.person_id     AS person_id,
      COALESCE(cm.email, p.email)  AS email,
      p.phone          AS phone,
      cm.membership_type
    FROM public.calendars_members cm
    LEFT JOIN public.people p ON p.id = cm.person_id
    WHERE cm.calendar_id = p_calendar_id
      AND cm.membership_status = ANY(v_status_filter)
      AND (array_length(v_membership_types, 1) IS NULL OR cm.membership_type = ANY(v_membership_types))
      AND (
        p_channel <> 'email'
        OR (
          (NOT v_require_email OR cm.email_notifications = true)
          AND cm.confirmed_at IS NOT NULL
          AND cm.unsubscribed_at IS NULL
          AND COALESCE(cm.email, p.email) IS NOT NULL
        )
      )
      AND (
        p_channel NOT IN ('sms','whatsapp')
        OR p.phone IS NOT NULL
      )
  ),
  -- Apply each event_participation group as a filter on the base set.
  -- Each group yields a set of person_ids that match its mode/kind/event_ids,
  -- and we AND the groups together by intersecting with the base set.
  filtered AS (
    SELECT b.*
    FROM base b
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_groups) AS g
      WHERE NOT (
        CASE g->>'mode'
          WHEN 'any_of' THEN
            EXISTS (
              SELECT 1
              FROM (
                SELECT er.person_id
                FROM public.events_registrations er
                JOIN public.events e ON e.id = er.event_uuid
                WHERE g->>'kind' = 'registered'
                  AND er.person_id = b.person_id
                  AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                UNION
                SELECT er.person_id
                FROM public.events_registrations er
                JOIN public.events e ON e.id = er.event_uuid
                WHERE g->>'kind' = 'attended'
                  AND er.person_id = b.person_id
                  AND er.checked_in_at IS NOT NULL
                  AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
              ) match
            )
          WHEN 'all_of' THEN
            (
              SELECT count(DISTINCT e.event_id)
              FROM public.events_registrations er
              JOIN public.events e ON e.id = er.event_uuid
              WHERE er.person_id = b.person_id
                AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                AND (g->>'kind' = 'registered' OR (g->>'kind' = 'attended' AND er.checked_in_at IS NOT NULL))
            ) = jsonb_array_length(g->'event_ids')
          WHEN 'none_of' THEN
            NOT EXISTS (
              SELECT 1
              FROM public.events_registrations er
              JOIN public.events e ON e.id = er.event_uuid
              WHERE er.person_id = b.person_id
                AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                AND (g->>'kind' = 'registered' OR (g->>'kind' = 'attended' AND er.checked_in_at IS NOT NULL))
            )
          ELSE TRUE
        END
      )
    )
  )
  SELECT
    f.member_id,
    f.person_id,
    f.email,
    f.phone,
    f.membership_type
  FROM filtered f;
END;
$$;

COMMENT ON FUNCTION public.resolve_calendar_audience(uuid, jsonb, text) IS
  'Single source of truth for calendar messaging audience. Used by both '
  'live preview (recipient count) and the actual blast send so they always '
  'agree. SECURITY DEFINER, restricted to admin callers via API gating.';

-- ==========================================================================
-- 5. Helper: count audience without returning rows (cheap preview)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.count_calendar_audience(
  p_calendar_id uuid,
  p_filter      jsonb,
  p_channel     text DEFAULT 'email'
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM public.resolve_calendar_audience(p_calendar_id, p_filter, p_channel);
$$;

COMMENT ON FUNCTION public.count_calendar_audience(uuid, jsonb, text) IS
  'Cheap count-only audience preview for the messaging UI live recipient counter.';
