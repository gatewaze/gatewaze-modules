-- ============================================================================
-- event-speakers 011: reconcile events_talk_speakers.speaker_id to the
-- cross-event speaker-profile model (the model ALL the code assumes)
--
-- The canonical model — used by events-speaker-submission, the 008
-- events_talks_with_speakers view, the 010 events_speakers_with_details view,
-- and migration 002's canonical_profile_id — is:
--
--     events_talk_speakers.speaker_id  ->  events_speaker_profiles(id)
--     events_speakers.speaker_id       ->  events_speaker_profiles(id)   (same id)
--
-- i.e. the bridge and the per-event participation row both point at the
-- person-level speaker identity. Prod already runs this model.
--
-- But the CONSOLIDATED migration 001 (line ~125) defines the bridge FK as
-- `-> events_speakers(id)`. Any DB built fresh from that (localhost, and a
-- fresh staging) ends up on a DIFFERENT model where the bridge points at the
-- participation row's id and events_speakers.speaker_id is left NULL by the
-- admin createSpeaker path. On those DBs the 008/010 views join nothing and
-- speakers render as "Unknown Speaker" / vanish from the By-Speaker view.
--
-- This migration reconciles a drifted DB to the profile model and is a NO-OP
-- where the DB is already correct (prod): the bridge repoint matches zero rows
-- (a profile id is never an events_speakers id), and the FK swap re-adds an
-- identical constraint. UUID id-spaces make the "is this an old-model row?"
-- test unambiguous.
--
-- Ordering matters: backfill profiles -> set es.speaker_id -> repoint bridge
-- data -> swap the FK last (so the new FK sees only valid profile ids).
-- ============================================================================

-- Step 1: backfill events_speaker_profiles for participation rows that never
-- got a cross-event identity (admin createSpeaker left speaker_id NULL). Dedupe
-- by person_id so a person added to several events shares one profile.
DO $$
DECLARE r record; v_profile uuid;
BEGIN
  FOR r IN
    SELECT es.id AS es_id, p.id AS person_id, p.email,
           NULLIF(TRIM(CONCAT(p.attributes->>'first_name', ' ', p.attributes->>'last_name')), '') AS full_name,
           p.attributes->>'company'  AS company,
           p.attributes->>'job_title' AS job_title,
           p.attributes->>'linkedin_url' AS linkedin_url,
           es.speaker_title
    FROM public.events_speakers es
    JOIN public.people_profiles pp ON pp.id = es.people_profile_id
    JOIN public.people p ON p.id = pp.person_id
    WHERE es.speaker_id IS NULL
  LOOP
    SELECT id INTO v_profile FROM public.events_speaker_profiles WHERE person_id = r.person_id LIMIT 1;
    IF v_profile IS NULL THEN
      INSERT INTO public.events_speaker_profiles (person_id, name, email, title, company, linkedin_url, is_active)
      VALUES (r.person_id, COALESCE(r.full_name, r.email, 'Unknown'), r.email,
              COALESCE(r.speaker_title, r.job_title), r.company, r.linkedin_url, true)
      RETURNING id INTO v_profile;
    END IF;
    UPDATE public.events_speakers SET speaker_id = v_profile WHERE id = r.es_id;
  END LOOP;
END $$;

-- Step 2: drop whatever single-column FK currently exists on speaker_id
-- (name-agnostic) BEFORE repointing the data — the old constraint (-> events_
-- speakers) would reject profile ids. Idempotent: on prod this drops the
-- existing profile-targeted FK and it is re-added identically at the end.
DO $$
DECLARE cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.events_talk_speakers'::regclass
    AND c.contype = 'f'
    AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                          WHERE a.attrelid = 'public.events_talk_speakers'::regclass
                            AND a.attname = 'speaker_id')]
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.events_talk_speakers DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- Step 3: repoint old-model bridge rows. A bridge row whose speaker_id equals an
-- events_speakers.id is on the old model; point it at that row's profile id.
-- (On the profile model, ts.speaker_id is a profile id and matches no es.id.)
UPDATE public.events_talk_speakers ts
SET speaker_id = es.speaker_id
FROM public.events_speakers es
WHERE ts.speaker_id = es.id
  AND es.speaker_id IS NOT NULL;

-- Step 4: drop any orphan bridge rows that still don't reference a real profile
-- (e.g. a participation row with no person to backfill from). These links were
-- already non-functional; removing them lets the corrected FK apply cleanly.
DELETE FROM public.events_talk_speakers ts
WHERE NOT EXISTS (SELECT 1 FROM public.events_speaker_profiles sp WHERE sp.id = ts.speaker_id);

-- Step 5: add the canonical FK -> events_speaker_profiles now that every bridge
-- row references a valid profile id.
ALTER TABLE public.events_talk_speakers
  ADD CONSTRAINT events_talk_speakers_speaker_id_fkey
  FOREIGN KEY (speaker_id) REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE;
