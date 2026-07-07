-- ============================================================================
-- Module: broadcasts
-- Migration: 012_broadcast_reply_status
-- Description: Triage status for broadcast replies — star (flag to come back to)
-- and archive (remove from the active list). Complements the existing is_read
-- flag. Toggled from the Replies tab; the existing authenticated-admin UPDATE
-- policy already covers these columns.
-- ============================================================================

ALTER TABLE public.broadcast_replies
  ADD COLUMN IF NOT EXISTS is_starred  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_broadcast_replies_status
  ON public.broadcast_replies (broadcast_id, is_archived, is_starred);
