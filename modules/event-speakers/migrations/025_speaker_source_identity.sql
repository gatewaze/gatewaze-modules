-- ============================================================================
-- Module: event-speakers
-- Migration: 025_speaker_source_identity
-- Description: Keep the upstream identifiers a speaker arrives with, and
--              define the identity keys dedupe matches on as IMMUTABLE
--              functions so the worker and the database cannot disagree.
-- ============================================================================
--
-- Why this exists.
--
-- A speaker imported from a conference programme arrives with two identifiers
-- and we were keeping neither. The one that matters is the numeric sched
-- account id in the avatar URL (//avatars.sched.co/c/9d/19223528/avatar.jpg),
-- which is served from sched's global avatar CDN rather than the event
-- subdomain and had 100% coverage on the AGNTcon EU programme: 112 avatar
-- URLs, 112 ids, 104 distinct people.
--
-- It is strictly better than the /speaker/<slug> URL, which looks like the
-- obvious key and is not. The slug is derived from the name, is a hex fallback
-- for speakers with no sched account (32 of 107 on that programme), and is not
-- unique per person: account 25691010 appears on that single page under both
-- `shaun.smith6` and `a541c24f08e01f75757c3d53da942006`.
--
-- Worse, avatar mirroring (event-agenda, 2026-10-11) actively destroyed this
-- information. The mirror stores the image at sha256(source URL), which is
-- one-way, so after that import ran prod held 0 profiles carrying a sched id
-- where the markup had offered 107. source_avatar_url fixes that by keeping
-- the URL we mirrored from.

SET statement_timeout = '300s';

-- ==========================================================================
-- 1. The upstream identifiers
-- ==========================================================================
ALTER TABLE public.events_speaker_profiles
  ADD COLUMN IF NOT EXISTS sched_user_id     text,
  ADD COLUMN IF NOT EXISTS source_avatar_url text,
  ADD COLUMN IF NOT EXISTS enrichment_source text;

COMMENT ON COLUMN public.events_speaker_profiles.enrichment_source IS
  'How linkedin_url was obtained, when it was not typed by a human or supplied by the speaker. "enrichlayer_name_company" means a FUZZY third-party match on name plus company, and the dedupe sweep deliberately refuses to auto-merge on such a URL: a wrong guess would give two different people the same slug and the sweep would then merge them with a confident-sounding reason. NULL means the value came from a source we trust (speaker submission, import, or a human).';

COMMENT ON COLUMN public.events_speaker_profiles.sched_user_id IS
  'Global sched.com account id, parsed from the avatar URL on import. Stable across events and across name changes, so it is the primary dedupe key for anything schedule-imported. NOT unique as a constraint: two profiles may legitimately hold the same id until the dedupe sweep merges them.';

COMMENT ON COLUMN public.events_speaker_profiles.source_avatar_url IS
  'The upstream avatar URL the local copy was made from. Kept because the mirrored path is sha256 of this value and therefore one-way, and because the sched account id lives in it.';

-- Not unique: the pre-merge state legitimately has repeats, and a unique
-- index here would make the importer fail rather than the sweep merge.
CREATE INDEX IF NOT EXISTS idx_speaker_profiles_sched_user_id
  ON public.events_speaker_profiles (sched_user_id)
  WHERE sched_user_id IS NOT NULL;

-- ==========================================================================
-- 2. The identity keys, as functions
-- ==========================================================================
--
-- These mirror modules/event-speakers/lib/dedupe/keys.ts exactly. Two copies
-- of a matching rule is a liability, and the alternative is worse: grouping
-- 6,000 profiles in the worker means fetching all of them, and grouping in SQL
-- with an inline expression means the expression drifts from the one the
-- worker uses to decide. Keep them in step, and change both together.

-- The name key. [^[:alnum:]] PRESERVES non-Latin scripts, which is load-bearing
-- rather than cosmetic: an ASCII-only version of this collapsed 103 Korean and
-- Japanese names to the empty string and reported 103 different people as one
-- duplicate group.
CREATE OR REPLACE FUNCTION public.speaker_name_key(v text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT lower(trim(regexp_replace(coalesce(v, ''), '[^[:alnum:]]+', ' ', 'g'))) $$;

COMMENT ON FUNCTION public.speaker_name_key(text) IS
  'Case-folded, punctuation-collapsed name for duplicate grouping. Preserves CJK. Mirrors nameKey() in lib/dedupe/keys.ts.';

-- The LinkedIn vanity slug. Matches /in/ and /pub/ only, so a /company/ or
-- /school/ page yields NULL and a shared employer can never read as a shared
-- person.
CREATE OR REPLACE FUNCTION public.speaker_linkedin_slug(v text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT nullif(lower((regexp_match(coalesce(v, ''), 'linkedin\.com/(?:in|pub)/([^/?#[:space:]]+)', 'i'))[1]), '')
$$;

COMMENT ON FUNCTION public.speaker_linkedin_slug(text) IS
  'LinkedIn profile slug, or NULL for a company/school page or a non-LinkedIn URL. Mirrors linkedinSlug() in lib/dedupe/keys.ts.';

-- The sched account id out of an avatar URL. The first path segment can be a
-- digit; an earlier regex used [a-z] there and silently missed 65 of 112
-- avatars on one page.
CREATE OR REPLACE FUNCTION public.speaker_sched_user_id(v text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (regexp_match(coalesce(v, ''), 'avatars\.sched\.co/[0-9a-z]+/[0-9a-f]{2}/([0-9]{3,})/', 'i'))[1]
$$;

COMMENT ON FUNCTION public.speaker_sched_user_id(text) IS
  'Global sched account id parsed from an avatar URL. Mirrors schedUserId() in lib/dedupe/keys.ts.';

-- ==========================================================================
-- 3. Indexes that make the duplicate sweep cheap
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_speaker_profiles_name_key
  ON public.events_speaker_profiles (public.speaker_name_key(name))
  WHERE canonical_profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_speaker_profiles_linkedin_slug
  ON public.events_speaker_profiles (public.speaker_linkedin_slug(linkedin_url))
  WHERE linkedin_url IS NOT NULL AND canonical_profile_id IS NULL;

-- ==========================================================================
-- 4. Backfill what is still recoverable
-- ==========================================================================
--
-- Any profile whose avatar_url is still a sched URL carries its account id in
-- plain sight. Profiles already mirrored into our bucket have lost it and need
-- a re-import to recover it, which the importer now does because it writes
-- both columns.
UPDATE public.events_speaker_profiles
SET sched_user_id = public.speaker_sched_user_id(avatar_url),
    source_avatar_url = COALESCE(source_avatar_url, avatar_url)
WHERE sched_user_id IS NULL
  AND public.speaker_sched_user_id(avatar_url) IS NOT NULL;

-- ==========================================================================
-- 5. Which profiles are worth paying an enrichment provider for
-- ==========================================================================
--
-- Only the ones whose name actually repeats. A full sweep of every profile
-- without a LinkedIn URL is a large bill for mostly no dedupe benefit, because
-- a profile with no duplicate does not need an identifier to resolve.
CREATE OR REPLACE FUNCTION public.speaker_dedupe_enrich_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, name text, company text, title text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH dup AS (
    SELECT public.speaker_name_key(name) AS nk
    FROM public.events_speaker_profiles
    WHERE canonical_profile_id IS NULL
    GROUP BY 1
    HAVING count(*) > 1 AND public.speaker_name_key(name) <> ''
  )
  SELECT sp.id, sp.name, sp.company, sp.title
  FROM public.events_speaker_profiles sp
  JOIN dup ON dup.nk = public.speaker_name_key(sp.name)
  WHERE sp.linkedin_url IS NULL
    AND sp.canonical_profile_id IS NULL
    AND sp.company IS NOT NULL
    AND sp.company <> ''
    -- Two or more name tokens. A single first name cannot be looked up
    -- usefully and must never be merged on anyway.
    AND array_length(string_to_array(public.speaker_name_key(sp.name), ' '), 1) >= 2
  ORDER BY sp.created_at DESC
  LIMIT greatest(1, least(500, coalesce(p_limit, 100)));
$$;

REVOKE ALL ON FUNCTION public.speaker_dedupe_enrich_candidates(integer) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.speaker_dedupe_enrich_candidates(integer) IS
  'Profiles with a repeated name, no LinkedIn URL and a company to disambiguate with — the only ones where an enrichment lookup can change a dedupe outcome.';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.events_speaker_profiles WHERE sched_user_id IS NOT NULL;
  RAISE NOTICE 'speaker source identity: % profile(s) now carry a sched account id.', n;
END $$;
