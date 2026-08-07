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
-- ============================================================================

DROP POLICY IF EXISTS storage_insert_talk_presentations ON storage.objects;
CREATE POLICY storage_insert_talk_presentations ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'media' AND name LIKE 'talks/%');
