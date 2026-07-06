-- ============================================================================
-- Module: event-speakers
-- Migration: 008_fix_talks_with_speakers_view
-- Description: events_talks_with_speakers joined the bridge table against the
-- WRONG parent, so the speakers array was always empty.
--
-- events_talk_speakers.speaker_id has an FK to events_speaker_profiles(id) —
-- the cross-event speaker identity. The view (from 004) joined
-- `events_speakers es ON es.id = ts.speaker_id`, i.e. it expected the
-- per-event participation row's id in that column. The FK makes that value
-- impossible to store, so the join never matched, `speakers` came back
-- '[]'::jsonb for every talk, and the admin rendered every CFP submission
-- as "Unknown Speaker" (observed on AAIF prod 2026-07-06 — both Voice
-- Agents Forum test submissions had correct bridge + profile rows but the
-- view returned speakers: []).
--
-- Fix: join per the actual FK —
--   ts.speaker_id → events_speaker_profiles sp (identity: name/email/etc.)
--   sp.id → events_speakers es, scoped to the talk's event via
--   es.event_uuid = t.event_uuid (per-event fields: bio/title/logo/
--   people_profile_id). Event-scoping matters: a speaker with rows on
--   several events must not fan out the jsonb_agg.
--
-- Output keys are unchanged so admin's mapTalkWithSpeakers keeps working;
-- one additive key `event_speaker_id` (es.id) is exposed for admin actions
-- that need the participation row.
-- ============================================================================

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
              ''event_speaker_id'', es.id,
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
          JOIN public.events_speaker_profiles sp ON sp.id = ts.speaker_id
          LEFT JOIN public.events_speakers es
            ON es.speaker_id = sp.id AND es.event_uuid = t.event_uuid
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
              ''event_speaker_id'', es.id,
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
          JOIN public.events_speaker_profiles sp ON sp.id = ts.speaker_id
          LEFT JOIN public.events_speakers es
            ON es.speaker_id = sp.id AND es.event_uuid = t.event_uuid
          LEFT JOIN public.people_profiles pp ON pp.id = es.people_profile_id
          LEFT JOIN public.people p ON p.id = pp.person_id
          WHERE ts.talk_id = t.id),
          ''[]''::jsonb
        ) AS speakers
      FROM public.events_talks t
    ';
  END IF;
END $$;

GRANT SELECT ON public.events_talks_with_speakers TO authenticated, anon, service_role;
