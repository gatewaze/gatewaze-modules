-- ============================================================================
-- 031_realtime_sends_and_log
-- ============================================================================
-- Add newsletter_sends + email_send_log to the supabase_realtime publication
-- so the admin's EditionSendingTab can subscribe via
--   supabase.channel(...).on('postgres_changes', { table: ..., filter: ... })
-- and replace the previous setInterval polling loop with live updates as
-- the send worker advances state and the email-webhook function records
-- delivered/opened/clicked/bounced events.
--
-- Idempotent — the ALTER PUBLICATION ... ADD TABLE silently no-ops if the
-- table is already a member (PG 15+ behaviour). For older PG we wrap in a
-- check-and-skip block.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'newsletter_sends'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.newsletter_sends';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'email_send_log'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.email_send_log';
  END IF;
END $$;
