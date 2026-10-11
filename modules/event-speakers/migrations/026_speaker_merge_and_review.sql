-- ============================================================================
-- Module: event-speakers
-- Migration: 026_speaker_merge_and_review
-- Description: Make a speaker merge actually dedupe what people see, make it
--              reversible, and add the review queue for groups no identifier
--              can settle.
-- ============================================================================
--
-- Why this exists.
--
-- Migration 002 added canonical_profile_id with the comment "reads resolve via
-- COALESCE(canonical_profile_id, id)". That is true of exactly one view,
-- calendar_talk_pool. The two surfaces people actually look at do not resolve
-- it at all: events_speaker_profiles_with_counts selects the column but still
-- returns the alias as its own row with its own event count, and
-- events_speakers_with_details never mentions it. So setting the pointer on
-- its own deduplicates nothing visible, which is why 0 of 6,031 profiles had
-- it set while 507 duplicate name groups sat in the table.
--
-- A merge therefore has to move the junction rows as well. That is destructive
-- in a way a pointer is not, so every move is recorded well enough to undo.

SET statement_timeout = '600s';

-- ==========================================================================
-- 1. Audit, extended so a merge can be explained and reversed
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.speakers_merge_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id    uuid NOT NULL,
  alias_id        uuid NOT NULL,
  canonical_email text,
  merged_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.speakers_merge_audit
  ADD COLUMN IF NOT EXISTS rule       text,
  ADD COLUMN IF NOT EXISTS reason     text,
  ADD COLUMN IF NOT EXISTS signals    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS merged_by  uuid,
  -- Exactly which junction rows moved, so unmerge puts them back rather than
  -- guessing. Shape: {"events_speakers":["<row uuid>", ...], ...}
  ADD COLUMN IF NOT EXISTS moved_rows jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz;

-- One live merge record per alias. A re-merge after a revert is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS speakers_merge_audit_one_live_per_alias
  ON public.speakers_merge_audit (alias_id)
  WHERE reverted_at IS NULL;

COMMENT ON COLUMN public.speakers_merge_audit.moved_rows IS
  'Junction row ids repointed from alias to canonical, per table. unmerge_speaker_profiles() reads this to restore them exactly rather than inferring which rows to move back.';

-- ==========================================================================
-- 2. The review queue
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.speaker_merge_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The group, smallest id first so the same group always keys the same way.
  profile_ids   uuid[] NOT NULL,
  group_key     text   NOT NULL,
  canonical_id  uuid   NOT NULL REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE,
  rule          text   NOT NULL,
  reason        text   NOT NULL,
  score         numeric(4,3) NOT NULL DEFAULT 0,
  signals       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  state         text   NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open', 'merged', 'rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One open candidate per group. `((group_key))` and not `((true))`: we want one
-- per group, which is what a plain expression index on the key gives, scoped
-- to the open state by the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS speaker_merge_candidates_one_open
  ON public.speaker_merge_candidates (group_key)
  WHERE state = 'open';

CREATE INDEX IF NOT EXISTS idx_speaker_merge_candidates_open_score
  ON public.speaker_merge_candidates (score DESC, created_at)
  WHERE state = 'open';

COMMENT ON TABLE public.speaker_merge_candidates IS
  'Groups that look like one person but hold no identifier strong enough to merge on. Never merged automatically. 337 of the 507 duplicate name groups on AAIF prod land here, because no row in them carries an email, a LinkedIn URL or a sched id.';

ALTER TABLE public.speaker_merge_candidates ENABLE ROW LEVEL SECURITY;

-- Admin surface only. The service role bypasses RLS for the worker; a logged-in
-- caller needs the same right that managing speakers needs.
DROP POLICY IF EXISTS speaker_merge_candidates_admin_read ON public.speaker_merge_candidates;
CREATE POLICY speaker_merge_candidates_admin_read
  ON public.speaker_merge_candidates FOR SELECT
  USING (public.is_super_admin());

DROP POLICY IF EXISTS speaker_merge_candidates_admin_write ON public.speaker_merge_candidates;
CREATE POLICY speaker_merge_candidates_admin_write
  ON public.speaker_merge_candidates FOR UPDATE
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

REVOKE ALL ON public.speaker_merge_candidates FROM anon;

-- ==========================================================================
-- 3. The merge
-- ==========================================================================
--
-- Repoints every junction from alias to canonical, then sets the pointer.
-- The three junctions with a UNIQUE (parent, speaker_id) need the colliding
-- alias row deleted rather than updated, or the UPDATE raises. events_speakers
-- has NO such constraint, so it can hold two rows for one person at one event
-- after a repoint and has to be de-duplicated explicitly.
CREATE OR REPLACE FUNCTION public.merge_speaker_profiles(
  p_canonical uuid,
  p_alias     uuid,
  p_rule      text DEFAULT 'manual',
  p_reason    text DEFAULT NULL,
  p_signals   jsonb DEFAULT '{}'::jsonb,
  p_actor     uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  moved jsonb := '{}'::jsonb;
  ids   uuid[];
BEGIN
  IF p_canonical IS NULL OR p_alias IS NULL OR p_canonical = p_alias THEN
    RAISE EXCEPTION 'merge needs two different profiles (canonical=%, alias=%)', p_canonical, p_alias;
  END IF;

  PERFORM 1 FROM public.events_speaker_profiles WHERE id = p_canonical;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical profile % does not exist', p_canonical; END IF;
  PERFORM 1 FROM public.events_speaker_profiles WHERE id = p_alias;
  IF NOT FOUND THEN RAISE EXCEPTION 'alias profile % does not exist', p_alias; END IF;

  -- Refuse to chain. If the canonical is itself an alias, merge into its root
  -- instead of building a two-hop pointer no view resolves.
  SELECT COALESCE(canonical_profile_id, id) INTO p_canonical
  FROM public.events_speaker_profiles WHERE id = p_canonical;
  IF p_canonical = p_alias THEN
    RAISE EXCEPTION 'refusing to merge % into itself via its canonical', p_alias;
  END IF;

  -- events_talk_speakers — UNIQUE (talk_id, speaker_id)
  DELETE FROM public.events_talk_speakers a
  WHERE a.speaker_id = p_alias
    AND EXISTS (SELECT 1 FROM public.events_talk_speakers c
                WHERE c.speaker_id = p_canonical AND c.talk_id = a.talk_id);
  WITH u AS (
    UPDATE public.events_talk_speakers SET speaker_id = p_canonical
    WHERE speaker_id = p_alias RETURNING id
  ) SELECT array_agg(id) INTO ids FROM u;
  moved := moved || jsonb_build_object('events_talk_speakers', to_jsonb(COALESCE(ids, '{}'::uuid[])));

  -- events_agenda_entry_speakers — UNIQUE (agenda_entry_id, speaker_id)
  DELETE FROM public.events_agenda_entry_speakers a
  WHERE a.speaker_id = p_alias
    AND EXISTS (SELECT 1 FROM public.events_agenda_entry_speakers c
                WHERE c.speaker_id = p_canonical AND c.agenda_entry_id = a.agenda_entry_id);
  WITH u AS (
    UPDATE public.events_agenda_entry_speakers SET speaker_id = p_canonical
    WHERE speaker_id = p_alias RETURNING id
  ) SELECT array_agg(id) INTO ids FROM u;
  moved := moved || jsonb_build_object('events_agenda_entry_speakers', to_jsonb(COALESCE(ids, '{}'::uuid[])));

  -- events_speakers_calendar_link — UNIQUE (speaker_profile_id, calendar_id)
  IF to_regclass('public.events_speakers_calendar_link') IS NOT NULL THEN
    DELETE FROM public.events_speakers_calendar_link a
    WHERE a.speaker_profile_id = p_alias
      AND EXISTS (SELECT 1 FROM public.events_speakers_calendar_link c
                  WHERE c.speaker_profile_id = p_canonical AND c.calendar_id = a.calendar_id);
    WITH u AS (
      UPDATE public.events_speakers_calendar_link SET speaker_profile_id = p_canonical
      WHERE speaker_profile_id = p_alias RETURNING id
    ) SELECT array_agg(id) INTO ids FROM u;
    moved := moved || jsonb_build_object('events_speakers_calendar_link', to_jsonb(COALESCE(ids, '{}'::uuid[])));
  END IF;

  -- events_speakers — NO unique constraint on (event_uuid, speaker_id), so a
  -- plain repoint would leave the same person listed twice on one event. Drop
  -- the alias row where the canonical is already on that event.
  DELETE FROM public.events_speakers a
  WHERE a.speaker_id = p_alias
    AND EXISTS (SELECT 1 FROM public.events_speakers c
                WHERE c.speaker_id = p_canonical AND c.event_uuid = a.event_uuid);
  WITH u AS (
    UPDATE public.events_speakers SET speaker_id = p_canonical
    WHERE speaker_id = p_alias RETURNING id
  ) SELECT array_agg(id) INTO ids FROM u;
  moved := moved || jsonb_build_object('events_speakers', to_jsonb(COALESCE(ids, '{}'::uuid[])));

  -- Fill blanks on the canonical from the alias. Never overwrite: the
  -- canonical was chosen for being the better record.
  UPDATE public.events_speaker_profiles c SET
    email             = COALESCE(c.email, a.email),
    title             = COALESCE(NULLIF(c.title, ''), a.title),
    company           = COALESCE(NULLIF(c.company, ''), a.company),
    bio               = COALESCE(NULLIF(c.bio, ''), a.bio),
    avatar_url        = COALESCE(c.avatar_url, a.avatar_url),
    source_avatar_url = COALESCE(c.source_avatar_url, a.source_avatar_url),
    sched_user_id     = COALESCE(c.sched_user_id, a.sched_user_id),
    linkedin_url      = COALESCE(c.linkedin_url, a.linkedin_url),
    twitter_url       = COALESCE(c.twitter_url, a.twitter_url),
    website_url       = COALESCE(c.website_url, a.website_url),
    person_id         = COALESCE(c.person_id, a.person_id),
    topics            = CASE WHEN coalesce(array_length(c.topics,1),0) = 0 THEN a.topics ELSE c.topics END,
    updated_at        = now()
  FROM public.events_speaker_profiles a
  WHERE c.id = p_canonical AND a.id = p_alias;

  -- Mark the alias. is_active false keeps it out of pickers without deleting
  -- the row, which is what makes this reversible.
  UPDATE public.events_speaker_profiles
  SET canonical_profile_id = p_canonical, is_active = false, updated_at = now()
  WHERE id = p_alias;

  INSERT INTO public.speakers_merge_audit
    (canonical_id, alias_id, canonical_email, rule, reason, signals, merged_by, moved_rows)
  VALUES
    (p_canonical, p_alias,
     (SELECT email FROM public.events_speaker_profiles WHERE id = p_canonical),
     p_rule, p_reason, COALESCE(p_signals, '{}'::jsonb), p_actor, moved);

  RETURN jsonb_build_object('canonical_id', p_canonical, 'alias_id', p_alias, 'moved', moved);
END $$;

REVOKE ALL ON FUNCTION public.merge_speaker_profiles(uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.merge_speaker_profiles(uuid, uuid, text, text, jsonb, uuid) IS
  'Repoints every speaker junction from alias to canonical, fills blanks on the canonical, sets canonical_profile_id and records enough in speakers_merge_audit.moved_rows to undo it. Service role / API only.';

-- ==========================================================================
-- 4. The undo
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.unmerge_speaker_profiles(p_alias uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec   record;
  moved jsonb;
BEGIN
  SELECT * INTO rec FROM public.speakers_merge_audit
  WHERE alias_id = p_alias AND reverted_at IS NULL
  ORDER BY merged_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live merge recorded for alias %', p_alias;
  END IF;
  moved := rec.moved_rows;

  -- Only the rows this merge moved go back. Rows deleted as collisions are
  -- NOT restored, because their content was a duplicate of a canonical row
  -- that still exists; restoring them would recreate the duplicate.
  UPDATE public.events_talk_speakers SET speaker_id = p_alias
  WHERE id = ANY (SELECT (jsonb_array_elements_text(COALESCE(moved->'events_talk_speakers','[]'::jsonb)))::uuid);

  UPDATE public.events_agenda_entry_speakers SET speaker_id = p_alias
  WHERE id = ANY (SELECT (jsonb_array_elements_text(COALESCE(moved->'events_agenda_entry_speakers','[]'::jsonb)))::uuid);

  IF to_regclass('public.events_speakers_calendar_link') IS NOT NULL THEN
    UPDATE public.events_speakers_calendar_link SET speaker_profile_id = p_alias
    WHERE id = ANY (SELECT (jsonb_array_elements_text(COALESCE(moved->'events_speakers_calendar_link','[]'::jsonb)))::uuid);
  END IF;

  UPDATE public.events_speakers SET speaker_id = p_alias
  WHERE id = ANY (SELECT (jsonb_array_elements_text(COALESCE(moved->'events_speakers','[]'::jsonb)))::uuid);

  UPDATE public.events_speaker_profiles
  SET canonical_profile_id = NULL, is_active = true, updated_at = now()
  WHERE id = p_alias;

  UPDATE public.speakers_merge_audit SET reverted_at = now() WHERE id = rec.id;

  RETURN jsonb_build_object('alias_id', p_alias, 'restored', moved);
END $$;

REVOKE ALL ON FUNCTION public.unmerge_speaker_profiles(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.unmerge_speaker_profiles(uuid) IS
  'Reverses one merge using speakers_merge_audit.moved_rows. Collision rows deleted during the merge are deliberately not restored — the canonical equivalent still exists.';

-- ==========================================================================
-- 5. Make the directory actually hide aliases
-- ==========================================================================
--
-- After a merge the alias has no junction rows, so it would appear in the
-- speakers directory as a 0-event orphan with a duplicate name — the symptom
-- the merge was meant to remove. The event rollup needs no change: the
-- canonical inherits the events because the junction rows now point at it.
CREATE OR REPLACE VIEW public.events_speaker_profiles_with_counts AS
SELECT
  sp.id, sp.name, sp.email, sp.title, sp.company, sp.bio, sp.avatar_url,
  sp.linkedin_url, sp.twitter_url, sp.website_url, sp.person_id,
  sp.canonical_profile_id, sp.topics, sp.availability_notes,
  sp.preferred_calendar_ids, sp.is_active, sp.created_at, sp.updated_at,
  COALESCE(agg.event_count, 0)               AS event_count,
  COALESCE(agg.event_uuids, ARRAY[]::uuid[]) AS event_uuids,
  -- Appended, not inserted. CREATE OR REPLACE VIEW can only add columns at
  -- the end: putting these before event_count shifts the existing positions
  -- and Postgres refuses with "cannot change name of view column".
  sp.sched_user_id,
  sp.source_avatar_url
FROM public.events_speaker_profiles sp
LEFT JOIN LATERAL (
  SELECT count(DISTINCT es.event_uuid)::integer AS event_count,
         array_agg(DISTINCT es.event_uuid)      AS event_uuids
  FROM public.events_speakers es
  WHERE es.speaker_id = sp.id
) agg ON true
WHERE sp.canonical_profile_id IS NULL;

ALTER VIEW public.events_speaker_profiles_with_counts SET (security_invoker = true);

COMMENT ON VIEW public.events_speaker_profiles_with_counts IS
  'Speakers directory read surface: profile + event_count + event_uuids, aliases excluded. security_invoker so RLS on events_speakers scopes the count to what the caller may see. Counts are per-profile and correct after a merge because merge_speaker_profiles() repoints the junction rows onto the canonical rather than relying on a view to resolve the pointer.';

REVOKE ALL ON public.events_speaker_profiles_with_counts FROM anon;
