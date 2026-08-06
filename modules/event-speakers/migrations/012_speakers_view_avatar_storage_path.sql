-- ============================================================================
-- event-speakers 012: fall back to the person's avatar_storage_path in the
-- speakers view avatar_url
--
-- Speakers who upload a fresh photo through the CFP form get a full public URL
-- in events_speaker_profiles.avatar_url. But a SIGNED-IN submitter's photo comes
-- from their existing person profile, stored as people.avatar_storage_path (a
-- bare storage path, avatar_url NULL). The view's avatar_url only COALESCEd the
-- *_url fields, so those speakers rendered with no avatar in the admin Speakers
-- tab even though the portal shows it (the portal resolves avatar_storage_path).
--
-- Add p.avatar_storage_path as the final COALESCE fallback. Both consumers
-- already resolve a bare path: the admin's resolveAvatarUrl() prepends the media
-- storage base, and the portal's storage-resolve lists avatar_url as resolvable.
-- CREATE OR REPLACE (supersedes migration 010's definition; same columns).
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
        COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url, p.avatar_storage_path) AS avatar_url,
        pp.qr_code_id,
        espon.id AS sponsor_profile_id,
        espon.sponsor_name, espon.sponsor_logo_url, espon.tier AS sponsor_tier,
        (SELECT t.status FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.speaker_id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_status,
        (SELECT t.submitted_at FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.speaker_id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
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
        COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url, p.avatar_storage_path) AS avatar_url,
        pp.qr_code_id,
        NULL::uuid AS sponsor_profile_id,
        NULL::text AS sponsor_name, NULL::text AS sponsor_logo_url,
        NULL::text AS sponsor_tier,
        (SELECT t.status FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.speaker_id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_status,
        (SELECT t.submitted_at FROM public.events_talk_speakers ts
           JOIN public.events_talks t ON t.id = ts.talk_id
          WHERE ts.speaker_id = es.speaker_id AND t.event_uuid = es.event_uuid AND ts.is_primary = true
          ORDER BY ts.sort_order NULLS LAST LIMIT 1) AS primary_talk_submitted_at
      FROM public.events_speakers es
      LEFT JOIN public.events_speaker_profiles sp ON sp.id = es.speaker_id
      LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
      LEFT JOIN public.people p ON p.id = pp.person_id
    ';
  END IF;
END $$;

GRANT SELECT ON public.events_speakers_with_details TO anon, authenticated, service_role;
