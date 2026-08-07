-- ============================================================================
-- Module: event-speakers
-- Migration: 016_talk_presentation_uploads
-- Description: Storage INSERT policy for speaker presentation uploads. The
--              confirmed-speaker checklist uploads decks to media/talks/*
--              directly from the browser (ConfirmedSpeakerTasks), but only
--              the speaker-submissions/ prefix ever got an INSERT policy
--              (009) — so every presentation upload has failed RLS on fresh
--              installs. Mirrors 009: INSERT-only, no read/update/delete
--              broadening; the bucket is public-read already.
--
--              Wrapped defensively: on cloud Supabase the migration runner's
--              pooled role may not own storage.objects (42501) — in that
--              case we skip with a NOTICE instead of aborting the module's
--              whole migration chain, and the policy must be created once
--              via a direct owner connection (as done for AAIF prod
--              2026-08-07).
-- ============================================================================

DO $$
BEGIN
  BEGIN
    DROP POLICY IF EXISTS storage_insert_talk_presentations ON storage.objects;
    CREATE POLICY storage_insert_talk_presentations ON storage.objects
      FOR INSERT TO anon, authenticated
      WITH CHECK (bucket_id = 'media' AND name LIKE 'talks/%');
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipping talks/ storage policy — role cannot modify storage.objects (create it via an owner connection)';
    WHEN duplicate_object THEN
      NULL; -- already present
  END;
END
$$;
