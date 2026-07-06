-- ============================================================================
-- Module: event-speakers
-- Migration: 009_speaker_submission_uploads
-- Description: Allow CFP submitters to upload their profile photo.
--
-- The speaker submission + edit forms upload the photo to
-- media/speaker-submissions/<timestamp>-<rand>.<ext> BEFORE calling the
-- events-speaker-submission fn (which then downloads + re-stores it against
-- the person via the service role). But storage.objects only had INSERT
-- policies for admins (is_admin()) and the winner-images/ prefix — a
-- speaker's upload failed RLS, the form swallowed the error and submitted
-- without an avatar, and the speaker showed with an empty photo everywhere
-- (observed on AAIF prod 2026-07-06: zero objects under
-- media/speaker-submissions/ despite submissions with photos).
--
-- Scope: INSERT-only, media bucket, speaker-submissions/ prefix, anon +
-- authenticated (the CFP form is public). No UPDATE/DELETE — objects are
-- write-once from the browser; the service role handles everything else.
-- ============================================================================

DROP POLICY IF EXISTS storage_insert_speaker_submissions ON storage.objects;
CREATE POLICY storage_insert_speaker_submissions ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'media' AND name LIKE 'speaker-submissions/%');
