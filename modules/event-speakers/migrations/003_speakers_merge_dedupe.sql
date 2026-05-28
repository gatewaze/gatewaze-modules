-- ============================================================================
-- Module: event-speakers
-- Migration: 003_speakers_merge_dedupe
-- Description: One-off dedupe of events_speaker_profiles by lower(email).
--              Finds multiple profiles sharing the same email and assigns
--              a canonical profile. Idempotent — safe to re-run.
--              Per spec-speakers-rollup.md §10 Phase 0.
-- ============================================================================

SET statement_timeout = '300s';

-- Audit table so we can see what was merged and roll back if needed
CREATE TABLE IF NOT EXISTS public.speakers_merge_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id    uuid NOT NULL,
  alias_id        uuid NOT NULL,
  canonical_email text,
  merged_at       timestamptz NOT NULL DEFAULT now()
);

-- For each group of profiles sharing a lower(email), pick the oldest as
-- canonical and set canonical_profile_id on the others.
WITH grouped AS (
  SELECT
    lower(email) AS email_lower,
    (array_agg(id ORDER BY created_at))[1] AS canonical_id,
    array_remove(array_agg(id ORDER BY created_at), (array_agg(id ORDER BY created_at))[1]) AS alias_ids
  FROM public.events_speaker_profiles
  WHERE email IS NOT NULL
    AND email <> ''
    AND canonical_profile_id IS NULL  -- skip already-merged rows
  GROUP BY lower(email)
  HAVING count(*) > 1
),
flattened AS (
  SELECT canonical_id, unnest(alias_ids) AS alias_id, email_lower
  FROM grouped
)
UPDATE public.events_speaker_profiles sp
SET canonical_profile_id = f.canonical_id
FROM flattened f
WHERE sp.id = f.alias_id
  AND sp.canonical_profile_id IS NULL;

-- Write an audit row for each merge
INSERT INTO public.speakers_merge_audit (canonical_id, alias_id, canonical_email)
SELECT DISTINCT
  sp_alias.canonical_profile_id,
  sp_alias.id,
  (SELECT email FROM public.events_speaker_profiles WHERE id = sp_alias.canonical_profile_id)
FROM public.events_speaker_profiles sp_alias
WHERE sp_alias.canonical_profile_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.speakers_merge_audit a
    WHERE a.alias_id = sp_alias.id
  );

-- Log results via NOTICE (visible in the migration runner's output)
DO $$
DECLARE
  merged_count integer;
BEGIN
  SELECT count(*) INTO merged_count FROM public.events_speaker_profiles WHERE canonical_profile_id IS NOT NULL;
  RAISE NOTICE 'Speaker profile dedupe complete. % profiles now marked as aliases.', merged_count;
END $$;
