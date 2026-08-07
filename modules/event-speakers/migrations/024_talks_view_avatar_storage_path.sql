-- ============================================================================
-- Module: event-speakers
-- Migration: 024_talks_view_avatar_storage_path
-- Description: A speaker who uploaded a photo showed a blank placeholder on
--              the admin talk cards and in the Talk Submission modal, even
--              though the photo was on their person record.
--
--              The two speaker views disagreed. events_speakers_with_details
--              resolves the avatar as
--                COALESCE(sp.avatar_url, p.avatar_url,
--                         p.linkedin_avatar_url, p.avatar_storage_path)
--              but events_talks_with_speakers stopped one short, at
--                COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url)
--
--              A photo uploaded through the portal lands in
--              people.avatar_storage_path and leaves avatar_url null, so the
--              talks view returned null and the card fell back to the
--              placeholder. The Speakers list, which reads the other view,
--              showed the same speaker's photo correctly.
--
--              This adds the missing fallback so both views agree. Nothing
--              else in the view changes; the body is 020's, with one
--              COALESCE extended.
-- ============================================================================

CREATE OR REPLACE VIEW public.events_talks_with_speakers AS
 SELECT t.id,
    t.event_uuid,
    t.title,
    t.synopsis,
    t.duration_minutes,
    t.session_type,
    t.status,
    t.sort_order,
    t.is_featured,
    t.event_sponsor_id,
    t.submitted_at,
    t.reviewed_at,
    t.reviewed_by,
    t.confirmation_token,
    t.edit_token,
    t.presentation_url,
    t.created_at,
    t.updated_at,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('speaker_id', ts.speaker_id, 'event_speaker_id', es.id, 'member_profile_id', es.people_profile_id, 'people_profile_id', es.people_profile_id, 'role', ts.role, 'is_primary', ts.is_primary, 'sort_order', ts.sort_order, 'is_featured', es.is_featured, 'email', COALESCE(sp.email, p.email), 'full_name', COALESCE(sp.name, TRIM(BOTH FROM concat(p.attributes ->> 'first_name'::text, ' ', p.attributes ->> 'last_name'::text)), p.email), 'first_name', COALESCE(sp.name, p.attributes ->> 'first_name'::text, p.email), 'last_name', COALESCE(p.attributes ->> 'last_name'::text, NULL::text), 'company', COALESCE(sp.company, p.attributes ->> 'company'::text), 'job_title', COALESCE(sp.title, p.attributes ->> 'job_title'::text), 'linkedin_url', COALESCE(sp.linkedin_url, p.attributes ->> 'linkedin_url'::text), 'avatar_url', COALESCE(sp.avatar_url, p.avatar_url, p.linkedin_avatar_url, p.avatar_storage_path), 'speaker_bio', es.speaker_bio, 'speaker_title', es.speaker_title, 'company_logo_storage_path', es.company_logo_storage_path, 'company_logo_url', es.company_logo_url) ORDER BY ts.sort_order) AS jsonb_agg
           FROM events_talk_speakers ts
             JOIN events_speaker_profiles sp ON sp.id = ts.speaker_id
             LEFT JOIN events_speakers es ON es.speaker_id = sp.id AND es.event_uuid = t.event_uuid
             LEFT JOIN people_profiles pp ON pp.id = es.people_profile_id
             LEFT JOIN people p ON p.id = pp.person_id
          WHERE ts.talk_id = t.id), '[]'::jsonb) AS speakers,
    espon.sponsor_name,
    espon.sponsor_logo_url,
    espon.tier AS sponsor_tier,
    -- Appended, not inserted mid-list: CREATE OR REPLACE VIEW can only add
    -- columns at the end (renaming an existing position errors out).
    t.presentation_storage_path,
    t.presentation_type
   FROM events_talks t
     LEFT JOIN events_sponsors espon ON espon.id = t.event_sponsor_id;

GRANT SELECT ON public.events_talks_with_speakers TO anon, authenticated, service_role;
