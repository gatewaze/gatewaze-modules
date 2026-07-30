-- ============================================================================
-- event-speakers 010: expose primary-talk lifecycle status on the speakers view
--
-- The speaker review lifecycle (submitted->pending, approved, rejected, reserve,
-- confirmed) is authoritatively tracked on events_talks.status via the
-- events_talk_speakers bridge (approve/reject/reserve go through
-- updatePrimaryTalkStatus; events-speaker-confirm sets events_talks.status =
-- 'confirmed'). events_speakers.status is a separate PARTICIPATION axis that is
-- NOT kept in sync — and the public portal filters events_speakers_with_details
-- by that participation status to decide which speakers are public
-- (events/public-api.ts: "Only confirmed speakers are public").
--
-- So we must NOT repoint the view's `status` (that would change who is public).
-- Instead, ADDITIVELY expose the primary talk's status + submitted_at so the
-- event Comms "Send to Existing <status> Speakers" count + email-batch-send
-- recipient resolution can target the review lifecycle correctly, while the
-- portal keeps using the untouched `status`. Correlated subqueries pick the talk
-- where this speaker is the primary presenter (events_talk_speakers.is_primary).
--
-- Join key: events_talk_speakers.speaker_id FKs to events_speakers(id) (migration
-- 001; the createSpeaker path inserts the bridge with the participation row's id).
-- So we join ts.speaker_id = es.id — the same key migration 008's
-- events_talks_with_speakers view uses. (events_speakers.speaker_id is the
-- separate, often-NULL events_speaker_profiles FK; joining on it silently returns
-- no talk for people-path speakers.)
--
-- CREATE OR REPLACE (columns only appended at the end) — preserves grants and
-- the existing column contract for portal / slack / speaker-tab consumers.
-- ============================================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsors') THEN
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
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier,
        (SELECT t.status FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_status,
        (SELECT t.submitted_at FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_submitted_at
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
      LEFT JOIN public.people p ON p.id = pp.person_id
      LEFT JOIN public.events_sponsors espon ON espon.id = es.event_sponsor_id
    ';
  ELSE
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
        NULL::text AS sponsor_tier,
        (SELECT t.status FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_status,
        (SELECT t.submitted_at FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_submitted_at
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
      LEFT JOIN public.people p ON p.id = pp.person_id
    ';
  END IF;
END $$;

GRANT SELECT ON public.events_speakers_with_details TO anon, authenticated, service_role;
