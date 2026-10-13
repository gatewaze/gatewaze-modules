-- ============================================================================
-- Module: google-sheets
-- Migration: 002_event_admin_rls_and_token_privileges
-- Description: Scope the Google Sheets tables to event admins, and keep the
-- Google OAuth tokens away from client roles.
--
-- 001 gave both tables a FOR ALL TO authenticated USING (true) policy. The
-- authenticated role includes non-admin portal users, so any signed-in user
-- could read, overwrite or delete every event's Google access and refresh
-- tokens, and read the sync logs (which carry registrant names and emails),
-- straight through PostgREST.
--
-- This migration:
--   1. Drops every policy these tables are known to carry: the 001 ones, and
--      the three older admin-scoped ones some installs still have from before
--      the module system.
--   2. Recreates the notification policies on public.can_admin_event_by_eid,
--      the same rule that gates editing the event itself. It is true for a
--      super_admin, and for an active admin with an active, unexpired
--      admin_event_permissions row for the event, which is what the older
--      policies checked. Logs become read-only for those admins; only the
--      service role (the edge functions) writes them.
--   3. Revokes every privilege client roles hold on both tables (including
--      TRUNCATE, which ignores row security, and TRIGGER and REFERENCES), then
--      grants back only what the admin needs: on the notifications table,
--      column lists that leave out google_access_token and
--      google_refresh_token, plus DELETE; on the logs table, SELECT. Row
--      policies cannot hide a column. The service role keeps full access.
--      A client select('*') on this table now fails, so every client reader
--      names its columns.
--   4. Adds google_connected, a generated boolean, so the admin can show
--      whether an account is connected without reading the token.
--
-- Idempotent, and a no-op where the module's tables do not exist.
-- ============================================================================

DO $$
DECLARE
  cols text;
BEGIN
  IF to_regclass('public.event_google_sheets_notifications') IS NULL THEN
    RAISE NOTICE 'google-sheets 002: event_google_sheets_notifications does not exist, skipping';
    RETURN;
  END IF;

  -- Fail rather than leave the table with no policy at all. The function is
  -- defined by core (a super_admin-only stub) and overridden by the events
  -- module, which this module depends on.
  IF to_regprocedure('public.can_admin_event_by_eid(text)') IS NULL THEN
    RAISE EXCEPTION 'google-sheets 002: public.can_admin_event_by_eid(text) is missing; install the events module first';
  END IF;

  -- 1. Drop old policies (both shapes seen in the wild).
  DROP POLICY IF EXISTS "auth_all_event_google_sheets" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "Event admins can view their Google Sheets notifications" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "Event admins can update Google Sheets notifications" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "Event admins can delete Google Sheets notifications" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "Event admins can insert Google Sheets notifications" ON public.event_google_sheets_notifications;
  -- This migration's own names, so a re-run replaces rather than fails.
  DROP POLICY IF EXISTS "google_sheets_notifications_select_event_admin" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "google_sheets_notifications_insert_event_admin" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "google_sheets_notifications_update_event_admin" ON public.event_google_sheets_notifications;
  DROP POLICY IF EXISTS "google_sheets_notifications_delete_event_admin" ON public.event_google_sheets_notifications;

  ALTER TABLE public.event_google_sheets_notifications ENABLE ROW LEVEL SECURITY;

  -- 2. Event-admin policies.
  CREATE POLICY "google_sheets_notifications_select_event_admin"
    ON public.event_google_sheets_notifications FOR SELECT TO authenticated
    USING (public.can_admin_event_by_eid(event_id::text));
  CREATE POLICY "google_sheets_notifications_insert_event_admin"
    ON public.event_google_sheets_notifications FOR INSERT TO authenticated
    WITH CHECK (public.can_admin_event_by_eid(event_id::text));
  CREATE POLICY "google_sheets_notifications_update_event_admin"
    ON public.event_google_sheets_notifications FOR UPDATE TO authenticated
    USING (public.can_admin_event_by_eid(event_id::text))
    WITH CHECK (public.can_admin_event_by_eid(event_id::text));
  CREATE POLICY "google_sheets_notifications_delete_event_admin"
    ON public.event_google_sheets_notifications FOR DELETE TO authenticated
    USING (public.can_admin_event_by_eid(event_id::text));

  -- 4. Connected flag (before the grants, so it can be granted).
  ALTER TABLE public.event_google_sheets_notifications
    ADD COLUMN IF NOT EXISTS google_connected boolean
    GENERATED ALWAYS AS (google_refresh_token IS NOT NULL) STORED;

  -- 3. Privileges. Start from nothing (PUBLIC included, in case anything was
  -- ever granted to it): anon never needs this table, and authenticated gets
  -- back only the lists below. A table-level REVOKE also
  -- removes column-level grants of the same privileges, so no stray grant on
  -- the token columns survives this.
  REVOKE ALL ON public.event_google_sheets_notifications FROM anon, authenticated, PUBLIC;
  -- Column lists are intersected with the columns that actually exist, so
  -- an older table shape missing one of them still gets the rest. The token
  -- columns are never in any list.
  -- event_id and notification_type are in the UPDATE list because a
  -- PostgREST upsert sets every column it was sent; the WITH CHECK above
  -- stops a row moving to an event the caller cannot admin.
  SELECT string_agg(quote_ident(column_name), ', ') INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'event_google_sheets_notifications'
     AND column_name = ANY (ARRAY[
       'id', 'event_id', 'notification_type', 'enabled', 'spreadsheet_id', 'spreadsheet_name',
       'sheet_name', 'column_mapping', 'google_user_email', 'google_connected',
       'created_at', 'updated_at']);
  EXECUTE format('GRANT SELECT (%s) ON public.event_google_sheets_notifications TO authenticated', cols);

  SELECT string_agg(quote_ident(column_name), ', ') INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'event_google_sheets_notifications'
     AND column_name = ANY (ARRAY[
       'event_id', 'notification_type', 'enabled', 'spreadsheet_id', 'spreadsheet_name',
       'sheet_name', 'column_mapping', 'updated_at']);
  EXECUTE format('GRANT INSERT (%s) ON public.event_google_sheets_notifications TO authenticated', cols);
  EXECUTE format('GRANT UPDATE (%s) ON public.event_google_sheets_notifications TO authenticated', cols);
  GRANT DELETE ON public.event_google_sheets_notifications TO authenticated;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.google_sheets_notification_logs') IS NULL THEN
    RAISE NOTICE 'google-sheets 002: google_sheets_notification_logs does not exist, skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.can_admin_event_by_eid(text)') IS NULL THEN
    RAISE EXCEPTION 'google-sheets 002: public.can_admin_event_by_eid(text) is missing; install the events module first';
  END IF;

  DROP POLICY IF EXISTS "auth_all_google_sheets_logs" ON public.google_sheets_notification_logs;
  DROP POLICY IF EXISTS "google_sheets_logs_select_event_admin" ON public.google_sheets_notification_logs;

  ALTER TABLE public.google_sheets_notification_logs ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "google_sheets_logs_select_event_admin"
    ON public.google_sheets_notification_logs FOR SELECT TO authenticated
    USING (public.can_admin_event_by_eid(event_id::text));

  -- Only the service role writes logs; event admins read them.
  REVOKE ALL ON public.google_sheets_notification_logs FROM anon, authenticated, PUBLIC;
  GRANT SELECT ON public.google_sheets_notification_logs TO authenticated;
END
$$;
