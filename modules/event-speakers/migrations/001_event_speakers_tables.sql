-- ============================================================================
-- Module: event-speakers
-- Migration: 001_event_speakers_tables
-- Description: Speaker profiles, event-speaker junction, talks, talk-speakers,
--              and speaker/talk views.
-- ============================================================================

-- ==========================================================================
-- 1. events_speaker_profiles
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_speaker_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text,
  title        text,
  company      text,
  bio          text,
  avatar_url   text,
  linkedin_url text,
  twitter_url  text,
  website_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER events_speaker_profiles_updated_at
  BEFORE UPDATE ON public.events_speaker_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_speakers (junction: events to speaker profiles)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_speakers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid                 uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  speaker_id                 uuid NOT NULL REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE,
  role                       text,
  sort_order                 integer,
  speaker_title              text,
  speaker_bio                text,
  speaker_topic              text,
  is_featured                boolean DEFAULT false,
  status                     text DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'approved', 'confirmed', 'reserve', 'rejected', 'placeholder')),
  participation_status       text
    CHECK (participation_status IN ('invited', 'pending', 'accepted', 'declined', 'confirmed')),
  company_logo_url           text,
  company_logo_storage_path  text,
  people_profile_id          uuid,
  event_sponsor_id           uuid,
  talk_title                 text,
  talk_synopsis              text,
  talk_duration_minutes      integer,
  submitted_at               timestamptz,
  reviewed_at                timestamptz,
  reviewed_by                uuid,
  confirmation_token         text,
  confirmed_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_uuid, speaker_id)
);

CREATE TRIGGER events_speakers_updated_at
  BEFORE UPDATE ON public.events_speakers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. events_talks
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_talks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  title             text NOT NULL,
  synopsis          text,
  duration_minutes  integer DEFAULT 30,
  session_type      text DEFAULT 'talk'
    CHECK (session_type IN ('talk', 'panel', 'workshop', 'lightning', 'fireside', 'keynote')),
  status            text DEFAULT 'pending'
    CHECK (status IN ('draft', 'pending', 'approved', 'confirmed', 'reserve', 'rejected', 'placeholder')),
  sort_order        integer DEFAULT 0,
  is_featured       boolean DEFAULT false,
  event_sponsor_id  uuid,
  submitted_at      timestamptz DEFAULT now(),
  reviewed_at       timestamptz,
  reviewed_by       uuid,
  confirmation_token text,
  edit_token        text,
  presentation_url  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_talks_event ON public.events_talks (event_uuid);
CREATE INDEX IF NOT EXISTS idx_events_talks_status ON public.events_talks (status);

CREATE TRIGGER events_talks_updated_at
  BEFORE UPDATE ON public.events_talks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Conditional FK: events_talks.event_sponsor_id → events_sponsors (if sponsors module installed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_talks_event_sponsor_id_fkey') THEN
      ALTER TABLE public.events_talks
        ADD CONSTRAINT events_talks_event_sponsor_id_fkey
        FOREIGN KEY (event_sponsor_id) REFERENCES public.events_sponsors(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 4. events_talk_speakers (junction: talks to speaker profiles)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_talk_speakers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talk_id     uuid NOT NULL REFERENCES public.events_talks(id) ON DELETE CASCADE,
  speaker_id  uuid NOT NULL REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE,
  role        text DEFAULT 'presenter'
    CHECK (role IN ('presenter', 'panelist', 'moderator', 'co_presenter', 'host')),
  is_primary  boolean DEFAULT true,
  sort_order  integer DEFAULT 0,
  UNIQUE (talk_id, speaker_id)
);

CREATE INDEX IF NOT EXISTS idx_events_talk_speakers_talk ON public.events_talk_speakers (talk_id);
CREATE INDEX IF NOT EXISTS idx_events_talk_speakers_speaker ON public.events_talk_speakers (speaker_id);

-- ==========================================================================
-- 5. Views (conditionally include sponsor joins if sponsors module is installed)
-- ==========================================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
    -- Full view with sponsor details
    EXECUTE '
      CREATE OR REPLACE VIEW public.events_speakers_with_details AS
      SELECT
        es.id, es.event_uuid, es.speaker_id, es.role, es.sort_order,
        es.speaker_title, es.speaker_bio, es.speaker_topic, es.is_featured,
        es.status, es.participation_status, es.company_logo_url,
        es.company_logo_storage_path, es.people_profile_id, es.event_sponsor_id,
        es.talk_title, es.talk_synopsis, es.talk_duration_minutes,
        es.submitted_at, es.reviewed_at, es.reviewed_by, es.confirmation_token,
        es.confirmed_at, es.created_at, es.updated_at,
        sp.email, sp.name AS full_name, sp.name AS first_name,
        NULL::text AS last_name, sp.company, sp.title AS job_title,
        sp.linkedin_url, sp.avatar_url,
        spon.id AS sponsor_profile_id,
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.events_sponsors espon ON espon.id = es.event_sponsor_id
      LEFT JOIN public.events_sponsor_profiles spon ON spon.id = espon.sponsor_profile_id
    ';

    EXECUTE '
      CREATE OR REPLACE VIEW public.events_talks_with_speakers AS
      SELECT
        t.id, t.event_uuid, t.title, t.synopsis, t.duration_minutes,
        t.session_type, t.status, t.sort_order, t.is_featured, t.event_sponsor_id,
        t.submitted_at, t.reviewed_at, t.reviewed_by, t.confirmation_token,
        t.edit_token, t.presentation_url, t.created_at, t.updated_at,
        COALESCE(
          (SELECT jsonb_agg(
            jsonb_build_object(
              ''speaker_id'', ts.speaker_id,
              ''people_profile_id'', es.people_profile_id,
              ''role'', ts.role, ''is_primary'', ts.is_primary,
              ''sort_order'', ts.sort_order, ''is_featured'', es.is_featured,
              ''email'', sp.email, ''full_name'', sp.name,
              ''first_name'', sp.name, ''last_name'', NULL,
              ''company'', sp.company, ''job_title'', sp.title,
              ''linkedin_url'', sp.linkedin_url, ''avatar_url'', sp.avatar_url,
              ''speaker_bio'', es.speaker_bio, ''speaker_title'', es.speaker_title,
              ''company_logo_storage_path'', es.company_logo_storage_path,
              ''company_logo_url'', es.company_logo_url
            ) ORDER BY ts.sort_order
          )
          FROM public.events_talk_speakers ts
          JOIN public.events_speaker_profiles sp ON sp.id = ts.speaker_id
          LEFT JOIN public.events_speakers es ON es.speaker_id = ts.speaker_id
            AND es.event_uuid = t.event_uuid
          WHERE ts.talk_id = t.id),
          ''[]''::jsonb
        ) AS speakers,
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier
      FROM public.events_talks t
      LEFT JOIN public.events_sponsors espon ON espon.id = t.event_sponsor_id
    ';
  ELSE
    -- Simplified view without sponsor details
    EXECUTE '
      CREATE OR REPLACE VIEW public.events_speakers_with_details AS
      SELECT
        es.id, es.event_uuid, es.speaker_id, es.role, es.sort_order,
        es.speaker_title, es.speaker_bio, es.speaker_topic, es.is_featured,
        es.status, es.participation_status, es.company_logo_url,
        es.company_logo_storage_path, es.people_profile_id, es.event_sponsor_id,
        es.talk_title, es.talk_synopsis, es.talk_duration_minutes,
        es.submitted_at, es.reviewed_at, es.reviewed_by, es.confirmation_token,
        es.confirmed_at, es.created_at, es.updated_at,
        sp.email, sp.name AS full_name, sp.name AS first_name,
        NULL::text AS last_name, sp.company, sp.title AS job_title,
        sp.linkedin_url, sp.avatar_url,
        NULL::uuid AS sponsor_profile_id,
        NULL::text AS sponsor_name, NULL::text AS sponsor_logo_url,
        NULL::text AS sponsor_tier
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
    ';

    EXECUTE '
      CREATE OR REPLACE VIEW public.events_talks_with_speakers AS
      SELECT
        t.id, t.event_uuid, t.title, t.synopsis, t.duration_minutes,
        t.session_type, t.status, t.sort_order, t.is_featured, t.event_sponsor_id,
        t.submitted_at, t.reviewed_at, t.reviewed_by, t.confirmation_token,
        t.edit_token, t.presentation_url, t.created_at, t.updated_at,
        COALESCE(
          (SELECT jsonb_agg(
            jsonb_build_object(
              ''speaker_id'', ts.speaker_id,
              ''people_profile_id'', es.people_profile_id,
              ''role'', ts.role, ''is_primary'', ts.is_primary,
              ''sort_order'', ts.sort_order, ''is_featured'', es.is_featured,
              ''email'', sp.email, ''full_name'', sp.name,
              ''first_name'', sp.name, ''last_name'', NULL,
              ''company'', sp.company, ''job_title'', sp.title,
              ''linkedin_url'', sp.linkedin_url, ''avatar_url'', sp.avatar_url,
              ''speaker_bio'', es.speaker_bio, ''speaker_title'', es.speaker_title,
              ''company_logo_storage_path'', es.company_logo_storage_path,
              ''company_logo_url'', es.company_logo_url
            ) ORDER BY ts.sort_order
          )
          FROM public.events_talk_speakers ts
          JOIN public.events_speaker_profiles sp ON sp.id = ts.speaker_id
          LEFT JOIN public.events_speakers es ON es.speaker_id = ts.speaker_id
            AND es.event_uuid = t.event_uuid
          WHERE ts.talk_id = t.id),
          ''[]''::jsonb
        ) AS speakers,
        NULL::text AS sponsor_name, NULL::text AS sponsor_logo_url,
        NULL::text AS sponsor_tier
      FROM public.events_talks t
    ';
  END IF;
END $$;

-- ==========================================================================
-- 6. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_speaker_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_speakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_talks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_talk_speakers ENABLE ROW LEVEL SECURITY;

-- Speaker profiles
CREATE POLICY "speakers_select_public"
  ON public.events_speaker_profiles FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.events_speakers es
    JOIN public.events e ON e.id = es.event_uuid
    WHERE es.speaker_id = events_speaker_profiles.id
      AND e.is_listed = true
  ));

CREATE POLICY "speakers_select_admin"
  ON public.events_speaker_profiles FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.events_speakers es
    JOIN public.events e ON e.id = es.event_uuid
    WHERE es.speaker_id = events_speaker_profiles.id
      AND e.is_listed = true
  ) OR public.is_admin());

CREATE POLICY "speakers_insert_admin"
  ON public.events_speaker_profiles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "speakers_update_admin"
  ON public.events_speaker_profiles FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "speakers_delete_admin"
  ON public.events_speaker_profiles FOR DELETE TO authenticated
  USING (public.is_admin());

-- Event speakers junction
CREATE POLICY "event_speakers_select_public"
  ON public.events_speakers FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_speakers.event_uuid
      AND e.is_listed = true
  ));

CREATE POLICY "event_speakers_select_admin"
  ON public.events_speakers FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_speakers.event_uuid
      AND e.is_listed = true
  ) OR public.is_admin());

CREATE POLICY "event_speakers_insert_admin"
  ON public.events_speakers FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_uuid));

CREATE POLICY "event_speakers_update_admin"
  ON public.events_speakers FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_uuid));

CREATE POLICY "event_speakers_delete_admin"
  ON public.events_speakers FOR DELETE TO authenticated
  USING (public.can_admin_event(event_uuid));

-- Talks
CREATE POLICY "anon_read_events_talks"
  ON public.events_talks FOR SELECT TO anon
  USING (true);

CREATE POLICY "auth_select_events_talks"
  ON public.events_talks FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "auth_insert_events_talks"
  ON public.events_talks FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_uuid));

CREATE POLICY "auth_update_events_talks"
  ON public.events_talks FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_uuid));

CREATE POLICY "auth_delete_events_talks"
  ON public.events_talks FOR DELETE TO authenticated
  USING (public.can_admin_event(event_uuid));

-- Talk speakers
CREATE POLICY "anon_read_events_talk_speakers"
  ON public.events_talk_speakers FOR SELECT TO anon
  USING (true);

CREATE POLICY "auth_select_events_talk_speakers"
  ON public.events_talk_speakers FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "auth_insert_events_talk_speakers"
  ON public.events_talk_speakers FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "auth_update_events_talk_speakers"
  ON public.events_talk_speakers FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "auth_delete_events_talk_speakers"
  ON public.events_talk_speakers FOR DELETE TO authenticated
  USING (public.is_admin());
