-- ============================================================================
-- Module: event-speakers
-- Migration: 012_speakers_event_count
-- Description: Per-speaker event rollup for the Speakers directory, so the
--              directory can show an "Events" count, sort by it, and filter
--              the list down to one event.
--
-- Two pieces:
--
--   1. idx_events_speakers_speaker
--      The junction's only existing index is the UNIQUE (event_uuid,
--      speaker_id) constraint, which LEADS with event_uuid. Aggregating the
--      other way round — "how many events does this speaker appear on" —
--      cannot use it and sequential-scans the whole junction today. This
--      index turns the per-speaker lookup into a range scan.
--
--   2. events_speaker_profiles_with_counts
--      The directory's read surface. Every events_speaker_profiles column
--      (enumerated, not `sp.*`, so a later ALTER TABLE on the base table
--      can't reorder this view's column contract), plus:
--        event_count  integer — distinct events the speaker appears on
--        event_uuids  uuid[]  — those event ids, so "filter by event" is one
--                               `event_uuids=ov.{…}` predicate instead of an
--                               N+1 round trip per rendered row.
--
-- Access model
-- ------------
-- security_invoker = true so the querying role's RLS on BOTH
-- events_speaker_profiles and events_speakers applies. A definer-rights view
-- (the PostgreSQL default) would compute the count with the view owner's
-- privileges and leak unlisted events into it.
--
-- Granted to authenticated + service_role only, and explicitly REVOKEd from
-- anon. anon's SELECT policy on events_speakers is scoped to events where
-- is_listed = true precisely so public traffic can't learn about unlisted or
-- draft events; handing anon a bare count and an id array would disclose the
-- same thing by a side channel. The directory is an admin surface — anon has
-- no reason to read it.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ==========================================================================
-- 1. Reverse-direction index on the junction
-- ==========================================================================

CREATE INDEX IF NOT EXISTS idx_events_speakers_speaker
  ON public.events_speakers (speaker_id);

COMMENT ON INDEX public.idx_events_speakers_speaker IS
  'Supports per-speaker aggregation (events_speaker_profiles_with_counts). The UNIQUE (event_uuid, speaker_id) index leads with event_uuid and cannot serve this direction.';

-- ==========================================================================
-- 2. Directory view with the event rollup
-- ==========================================================================

CREATE OR REPLACE VIEW public.events_speaker_profiles_with_counts AS
SELECT
  sp.id,
  sp.name,
  sp.email,
  sp.title,
  sp.company,
  sp.bio,
  sp.avatar_url,
  sp.linkedin_url,
  sp.twitter_url,
  sp.website_url,
  sp.person_id,
  sp.canonical_profile_id,
  sp.topics,
  sp.availability_notes,
  sp.preferred_calendar_ids,
  sp.is_active,
  sp.created_at,
  sp.updated_at,
  COALESCE(agg.event_count, 0)                 AS event_count,
  COALESCE(agg.event_uuids, ARRAY[]::uuid[])   AS event_uuids
FROM public.events_speaker_profiles sp
LEFT JOIN LATERAL (
  SELECT
    count(DISTINCT es.event_uuid)::integer AS event_count,
    array_agg(DISTINCT es.event_uuid)      AS event_uuids
  FROM public.events_speakers es
  WHERE es.speaker_id = sp.id
) agg ON true;

ALTER VIEW public.events_speaker_profiles_with_counts SET (security_invoker = true);

COMMENT ON VIEW public.events_speaker_profiles_with_counts IS
  'Speakers directory read surface: speaker profile + event_count + event_uuids. security_invoker so RLS on events_speakers scopes the count to what the caller may see. Counts are per-profile — an alias profile (canonical_profile_id IS NOT NULL) keeps its own events rather than rolling them into the canonical row, which is what keeps event_count and the event_uuids filter mutually consistent.';

-- Admin surface only. anon is revoked explicitly because Supabase default
-- privileges in the public schema would otherwise hand it a SELECT grant.
REVOKE ALL ON public.events_speaker_profiles_with_counts FROM anon;
GRANT SELECT ON public.events_speaker_profiles_with_counts TO authenticated, service_role;
