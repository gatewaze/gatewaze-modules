-- ============================================================================
-- 098_realtime_edition_approvals
-- ============================================================================
-- Add newsletters_edition_approvals to the supabase_realtime publication so
-- the Sending tab's ApprovalPanel can subscribe with
--   supabase.channel(...).on('postgres_changes', { table, filter: edition_id })
-- and show an approver's decision without a page refresh. Realtime applies
-- RLS, so only admins (the existing newsletters_edition_approvals_admin_read
-- policy) receive these rows.
--
-- Idempotent, and a no-op where the publication does not exist.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename  = 'newsletters_edition_approvals'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.newsletters_edition_approvals';
  END IF;
END $$;
