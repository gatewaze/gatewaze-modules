-- ============================================================================
-- Module: newsletters
-- Migration: 065_newsletter_reply_status
-- Description: Triage status for newsletter replies — star (flag to come back
-- to) and archive (remove from the active list). Complements is_read. Toggled
-- from the Replies tab; the existing authenticated-admin UPDATE policy already
-- covers these columns.
-- ============================================================================

ALTER TABLE public.newsletter_replies
  ADD COLUMN IF NOT EXISTS is_starred  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_newsletter_replies_status
  ON public.newsletter_replies (collection_id, is_archived, is_starred);
