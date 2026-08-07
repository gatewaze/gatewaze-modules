-- ============================================================================
-- Module: bulk-emailing
-- Migration: 026_event_reply_messages_align
-- Description: Aligns event_reply_messages with broadcast_reply_messages so
--              reply-send's single generic insert works for events.
--
--              EXPAND-ONLY (spec §5.9). The first cut of this migration used
--              RENAME COLUMN / DROP COLUMN and was correctly rejected by the
--              migration guard: both break single-release rollback. The old
--              columns are therefore left in place and merely made nullable,
--              and a later release can drop them once nothing reads them.
--
--              Written to converge from EITHER starting shape, because the
--              rejected version was applied by hand to one environment before
--              the guard caught it:
--                - 025 shape:  to_email/from_email (NOT NULL), send_log_id
--                - renamed:    to_address/from_address already present
-- ============================================================================

ALTER TABLE public.event_reply_messages
  ADD COLUMN IF NOT EXISTS to_address text,
  ADD COLUMN IF NOT EXISTS from_address text,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

DO $$
BEGIN
  -- Legacy columns from 025: keep them (contract in a later release) but stop
  -- them blocking inserts that only populate the aligned column names.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_reply_messages'
      AND column_name = 'to_email' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.event_reply_messages ALTER COLUMN to_email DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_reply_messages'
      AND column_name = 'from_email' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.event_reply_messages ALTER COLUMN from_email DROP NOT NULL;
  END IF;

  -- Carry any rows written under the old shape across to the new columns.
  -- No-op where the legacy columns were already renamed away.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_reply_messages'
      AND column_name = 'to_email'
  ) THEN
    EXECUTE 'UPDATE public.event_reply_messages
               SET to_address = COALESCE(to_address, to_email),
                   from_address = COALESCE(from_address, from_email)
             WHERE to_address IS NULL OR from_address IS NULL';
  END IF;
END
$$;
