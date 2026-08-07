-- ============================================================================
-- Module: bulk-emailing
-- Migration: 026_event_reply_messages_align
-- Description: Aligns event_reply_messages with broadcast_reply_messages.
--
--              reply-send inserts the outbound thread message with ONE generic
--              shape and only varies the table + parent key. 025 invented its
--              own column names (to_email/from_email/send_log_id), so that
--              insert would have failed for events. Matching the existing
--              shape keeps reply-send free of a third column mapping.
--
--              Safe to rename: the table ships in the same release as this fix
--              and holds no rows anywhere.
-- ============================================================================

ALTER TABLE public.event_reply_messages
  RENAME COLUMN to_email TO to_address;

ALTER TABLE public.event_reply_messages
  RENAME COLUMN from_email TO from_address;

ALTER TABLE public.event_reply_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

-- send_log_id was unused by reply-send (it logs to email_send_log without a
-- campaign id, and doesn't thread the new row back here). Dropped rather than
-- left as a column nothing populates.
ALTER TABLE public.event_reply_messages
  DROP COLUMN IF EXISTS send_log_id;
