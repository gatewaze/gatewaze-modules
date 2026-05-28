-- ============================================================================
-- Module: event-speakers
-- Migration: 004_speaker_id_nullable
-- Description: Makes speaker_id nullable on events_speakers. New speakers are
--              linked via people_profile_id (from the people system) rather
--              than the legacy events_speaker_profiles table. Existing rows
--              with a speaker_id are unaffected.
--              Also drops the unique constraint on (event_uuid, speaker_id)
--              since null speaker_ids would violate it.
--              Rebuilds the events_speakers_with_details view to COALESCE
--              name/email/avatar from both the legacy events_speaker_profiles
--              path (speaker_id) and the new people system path
--              (people_profile_id → people_profiles → people).
-- ============================================================================

ALTER TABLE public.events_speakers ALTER COLUMN speaker_id DROP NOT NULL;

ALTER TABLE public.events_speakers
  DROP CONSTRAINT IF EXISTS events_speakers_event_uuid_speaker_id_key;

-- Rebuild the view to pull details from the people system when
-- speaker_id is NULL (i.e. the speaker was added via people_profile_id).
-- DROP + CREATE because the column list order changed (can't use CREATE OR REPLACE).
DROP VIEW IF EXISTS public.events_speakers_with_details CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
    EXECUTE '
      CREATE VIEW public.events_speakers_with_details AS
      SELECT
        es.id, es.event_uuid, es.speaker_id, es.role, es.sort_order,
        es.speaker_title, es.speaker_bio, es.speaker_topic, es.is_featured,
        es.status, es.participation_status, es.company_logo_url,
        es.company_logo_storage_path, es.people_profile_id, es.event_sponsor_id,
        es.talk_title, es.talk_synopsis, es.talk_duration_minutes,
        es.submitted_at, es.reviewed_at, es.reviewed_by, es.confirmation_token,
        es.confirmed_at, es.created_at, es.updated_at,
        COALESCE(sp.email, p.email) AS email,
        COALESCE(
          sp.name,
          TRIM(CONCAT(p.attributes->>''first_name'', '' '', p.attributes->>''last_name'')),
          p.email
        ) AS full_name,
        COALESCE(sp.name, p.attributes->>''first_name'', p.email) AS first_name,
        COALESCE(p.attributes->>''last_name'', NULL::text) AS last_name,
        COALESCE(sp.company, p.attributes->>''company'') AS company,
        COALESCE(sp.title, p.attributes->>''job_title'') AS job_title,
        COALESCE(sp.linkedin_url, p.attributes->>''linkedin_url'') AS linkedin_url,
        COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url) AS avatar_url,
        pp.qr_code_id,
        espon.id AS sponsor_profile_id,
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
      LEFT JOIN public.people p ON p.id = pp.person_id
      LEFT JOIN public.events_sponsors espon ON espon.id = es.event_sponsor_id
    ';
  ELSE
    EXECUTE '
      CREATE VIEW public.events_speakers_with_details AS
      SELECT
        es.id, es.event_uuid, es.speaker_id, es.role, es.sort_order,
        es.speaker_title, es.speaker_bio, es.speaker_topic, es.is_featured,
        es.status, es.participation_status, es.company_logo_url,
        es.company_logo_storage_path, es.people_profile_id, es.event_sponsor_id,
        es.talk_title, es.talk_synopsis, es.talk_duration_minutes,
        es.submitted_at, es.reviewed_at, es.reviewed_by, es.confirmation_token,
        es.confirmed_at, es.created_at, es.updated_at,
        COALESCE(sp.email, p.email) AS email,
        COALESCE(
          sp.name,
          TRIM(CONCAT(p.attributes->>''first_name'', '' '', p.attributes->>''last_name'')),
          p.email
        ) AS full_name,
        COALESCE(sp.name, p.attributes->>''first_name'', p.email) AS first_name,
        COALESCE(p.attributes->>''last_name'', NULL::text) AS last_name,
        COALESCE(sp.company, p.attributes->>''company'') AS company,
        COALESCE(sp.title, p.attributes->>''job_title'') AS job_title,
        COALESCE(sp.linkedin_url, p.attributes->>''linkedin_url'') AS linkedin_url,
        COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url) AS avatar_url,
        pp.qr_code_id,
        NULL::uuid AS sponsor_profile_id,
        NULL::text AS sponsor_name, NULL::text AS sponsor_logo_url,
        NULL::text AS sponsor_tier
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
      LEFT JOIN public.people p ON p.id = pp.person_id
    ';
  END IF;
END $$;

-- Re-grant access (DROP VIEW removes grants)
GRANT SELECT ON public.events_speakers_with_details TO anon, authenticated, service_role;

-- Also rebuild events_talks_with_speakers: the speakers subquery was joining
-- events_speaker_profiles via ts.speaker_id (which is actually events_speakers.id,
-- not events_speaker_profiles.id). Rewrite to go through events_speakers first,
-- then COALESCE from both legacy and people system paths.
DROP VIEW IF EXISTS public.events_talks_with_speakers CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
    EXECUTE '
      CREATE VIEW public.events_talks_with_speakers AS
      SELECT
        t.id, t.event_uuid, t.title, t.synopsis, t.duration_minutes,
        t.session_type, t.status, t.sort_order, t.is_featured, t.event_sponsor_id,
        t.submitted_at, t.reviewed_at, t.reviewed_by, t.confirmation_token,
        t.edit_token, t.presentation_url, t.created_at, t.updated_at,
        COALESCE(
          (SELECT jsonb_agg(
            jsonb_build_object(
              ''speaker_id'', ts.speaker_id,
              ''member_profile_id'', es.people_profile_id,
              ''people_profile_id'', es.people_profile_id,
              ''role'', ts.role, ''is_primary'', ts.is_primary,
              ''sort_order'', ts.sort_order, ''is_featured'', es.is_featured,
              ''email'', COALESCE(sp.email, p.email),
              ''full_name'', COALESCE(sp.name, TRIM(CONCAT(p.attributes->>''first_name'', '' '', p.attributes->>''last_name'')), p.email),
              ''first_name'', COALESCE(sp.name, p.attributes->>''first_name'', p.email),
              ''last_name'', COALESCE(p.attributes->>''last_name'', NULL),
              ''company'', COALESCE(sp.company, p.attributes->>''company''),
              ''job_title'', COALESCE(sp.title, p.attributes->>''job_title''),
              ''linkedin_url'', COALESCE(sp.linkedin_url, p.attributes->>''linkedin_url''),
              ''avatar_url'', COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url),
              ''speaker_bio'', es.speaker_bio, ''speaker_title'', es.speaker_title,
              ''company_logo_storage_path'', es.company_logo_storage_path,
              ''company_logo_url'', es.company_logo_url
            ) ORDER BY ts.sort_order
          )
          FROM public.events_talk_speakers ts
          JOIN public.events_speakers es ON es.id = ts.speaker_id
          LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
          LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
          LEFT JOIN public.people p ON p.id = pp.person_id
          WHERE ts.talk_id = t.id),
          ''[]''::jsonb
        ) AS speakers,
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier
      FROM public.events_talks t
      LEFT JOIN public.events_sponsors espon ON espon.id = t.event_sponsor_id
    ';
  ELSE
    EXECUTE '
      CREATE VIEW public.events_talks_with_speakers AS
      SELECT
        t.id, t.event_uuid, t.title, t.synopsis, t.duration_minutes,
        t.session_type, t.status, t.sort_order, t.is_featured, t.event_sponsor_id,
        t.submitted_at, t.reviewed_at, t.reviewed_by, t.confirmation_token,
        t.edit_token, t.presentation_url, t.created_at, t.updated_at,
        COALESCE(
          (SELECT jsonb_agg(
            jsonb_build_object(
              ''speaker_id'', ts.speaker_id,
              ''member_profile_id'', es.people_profile_id,
              ''people_profile_id'', es.people_profile_id,
              ''role'', ts.role, ''is_primary'', ts.is_primary,
              ''sort_order'', ts.sort_order, ''is_featured'', es.is_featured,
              ''email'', COALESCE(sp.email, p.email),
              ''full_name'', COALESCE(sp.name, TRIM(CONCAT(p.attributes->>''first_name'', '' '', p.attributes->>''last_name'')), p.email),
              ''first_name'', COALESCE(sp.name, p.attributes->>''first_name'', p.email),
              ''last_name'', COALESCE(p.attributes->>''last_name'', NULL),
              ''company'', COALESCE(sp.company, p.attributes->>''company''),
              ''job_title'', COALESCE(sp.title, p.attributes->>''job_title''),
              ''linkedin_url'', COALESCE(sp.linkedin_url, p.attributes->>''linkedin_url''),
              ''avatar_url'', COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url),
              ''speaker_bio'', es.speaker_bio, ''speaker_title'', es.speaker_title,
              ''company_logo_storage_path'', es.company_logo_storage_path,
              ''company_logo_url'', es.company_logo_url
            ) ORDER BY ts.sort_order
          )
          FROM public.events_talk_speakers ts
          JOIN public.events_speakers es ON es.id = ts.speaker_id
          LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
          LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
          LEFT JOIN public.people p ON p.id = pp.person_id
          WHERE ts.talk_id = t.id),
          ''[]''::jsonb
        ) AS speakers,
        NULL::text AS sponsor_name, NULL::text AS sponsor_logo_url,
        NULL::text AS sponsor_tier
      FROM public.events_talks t
    ';
  END IF;
END $$;

GRANT SELECT ON public.events_talks_with_speakers TO anon, authenticated, service_role;
