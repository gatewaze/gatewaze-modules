-- ============================================================================
-- Module: event-speakers
-- Migration: 002_speakers_rollup
-- Description: Extends event-speakers to support calendar- and platform-level
--              speaker pools. Talks become scope-aware (event/calendar/
--              platform) and speaker profiles get a canonical person link
--              for soft-merging duplicates. Per spec-speakers-rollup.md §5.
-- ============================================================================

-- ==========================================================================
-- 1. events_talks — make event optional, add scope, calendar_id (soft refs)
-- ==========================================================================
ALTER TABLE public.events_talks
  ALTER COLUMN event_uuid DROP NOT NULL;

ALTER TABLE public.events_talks
  ADD COLUMN IF NOT EXISTS calendar_id uuid,          -- soft ref; no FK
  ADD COLUMN IF NOT EXISTS origin_calendar_id uuid,   -- survives promote-to-event
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'event'
    CHECK (scope IN ('event','calendar','platform')),
  ADD COLUMN IF NOT EXISTS available_from date,
  ADD COLUMN IF NOT EXISTS available_until date,
  ADD COLUMN IF NOT EXISTS topics text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS submitter_email text,
  ADD COLUMN IF NOT EXISTS submitter_name text;

-- Constraint: scope dictates which column is set
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_talks_scope_consistency'
  ) THEN
    ALTER TABLE public.events_talks
      ADD CONSTRAINT events_talks_scope_consistency CHECK (
        (scope = 'event'    AND event_uuid IS NOT NULL AND calendar_id IS NULL)
        OR (scope = 'calendar' AND event_uuid IS NULL AND calendar_id IS NOT NULL)
        OR (scope = 'platform' AND event_uuid IS NULL AND calendar_id IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_talks_calendar
  ON public.events_talks (calendar_id, status, submitted_at DESC)
  WHERE calendar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_talks_origin_calendar
  ON public.events_talks (origin_calendar_id) WHERE origin_calendar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_talks_platform
  ON public.events_talks (status, submitted_at DESC)
  WHERE scope = 'platform';
CREATE INDEX IF NOT EXISTS idx_events_talks_topics
  ON public.events_talks USING gin (topics);

COMMENT ON COLUMN public.events_talks.calendar_id IS
  'Soft reference to calendars(id). Present when scope=calendar. No FK because calendars is an optional module.';
COMMENT ON COLUMN public.events_talks.origin_calendar_id IS
  'Originating calendar, preserved even after promote-to-event so chapter organisers can see every talk ever submitted.';

-- ==========================================================================
-- 2. events_speaker_profiles — canonical person link + profile fields
-- ==========================================================================
ALTER TABLE public.events_speaker_profiles
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_profile_id uuid REFERENCES public.events_speaker_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS topics text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS availability_notes text,
  ADD COLUMN IF NOT EXISTS preferred_calendar_ids uuid[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_speaker_profiles_person
  ON public.events_speaker_profiles (person_id)
  WHERE person_id IS NOT NULL AND canonical_profile_id IS NULL;

COMMENT ON COLUMN public.events_speaker_profiles.canonical_profile_id IS
  'If set, this profile is an alias of another. Reads resolve via COALESCE(canonical_profile_id, id).';

-- ==========================================================================
-- 3. calendar_talk_pool view — admin working surface
-- ==========================================================================
CREATE OR REPLACE VIEW public.calendar_talk_pool AS
SELECT
  t.id,
  t.calendar_id,
  t.origin_calendar_id,
  t.title,
  t.synopsis,
  t.duration_minutes,
  t.topics,
  t.status,
  t.available_from,
  t.available_until,
  t.submitted_at,
  t.reviewed_at,
  t.reviewed_by,
  t.submitter_email,
  t.submitter_name,
  COALESCE(sp.canonical_profile_id, sp.id) AS speaker_profile_id,
  sp.name  AS speaker_name,
  sp.email AS speaker_email,
  sp.title AS speaker_title,
  sp.company AS speaker_company,
  sp.person_id AS speaker_person_id,
  sp.topics AS speaker_topics
FROM public.events_talks t
LEFT JOIN public.events_talk_speakers ts
  ON ts.talk_id = t.id AND ts.is_primary = true
LEFT JOIN public.events_speakers es ON es.id = ts.speaker_id
LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
WHERE t.scope = 'calendar' OR t.origin_calendar_id IS NOT NULL;

COMMENT ON VIEW public.calendar_talk_pool IS
  'Working surface for chapter organisers: all talks ever associated with a calendar, including promoted ones.';

-- ==========================================================================
-- 4. events_speakers_calendar_link — speaker ↔ calendar history (optional)
--    Only created if calendars module is installed.
-- ==========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='calendars') THEN
    CREATE TABLE IF NOT EXISTS public.events_speakers_calendar_link (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      speaker_profile_id uuid NOT NULL REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE,
      calendar_id        uuid NOT NULL REFERENCES public.calendars(id) ON DELETE CASCADE,
      first_seen_at      timestamptz NOT NULL DEFAULT now(),
      last_seen_at       timestamptz NOT NULL DEFAULT now(),
      talk_count         integer NOT NULL DEFAULT 0,
      attendance_count   integer NOT NULL DEFAULT 0,
      metadata           jsonb DEFAULT '{}'::jsonb,
      UNIQUE (speaker_profile_id, calendar_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_speakers_calendar_link_calendar
      ON public.events_speakers_calendar_link (calendar_id);
    CREATE INDEX IF NOT EXISTS idx_events_speakers_calendar_link_speaker
      ON public.events_speakers_calendar_link (speaker_profile_id);
  END IF;
END $$;

-- ==========================================================================
-- 5. RLS on events_speakers_calendar_link (if table exists)
-- ==========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_speakers_calendar_link') THEN
    ALTER TABLE public.events_speakers_calendar_link ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS events_speakers_calendar_link_select ON public.events_speakers_calendar_link;
    CREATE POLICY events_speakers_calendar_link_select
      ON public.events_speakers_calendar_link
      FOR SELECT USING (
        public.is_super_admin() OR public.can_admin_calendar(calendar_id)
      );
  END IF;
END $$;
