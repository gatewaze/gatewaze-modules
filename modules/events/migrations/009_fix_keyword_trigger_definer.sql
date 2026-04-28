-- ============================================================================
-- events module — fix events_ck_enqueue trigger to bypass RLS
--
-- The original definition in 005_keyword_adapter.sql was plain SECURITY INVOKER,
-- so when a non-service_role user (e.g. an admin editing an event via
-- events_update) caused an UPDATE on `events`, the AFTER trigger fired and
-- tried to INSERT into `content_keyword_match_queue` — which has an RLS
-- policy that only permits service_role writes. Result: 42501 ("new row
-- violates row-level security policy for table content_keyword_match_queue").
--
-- Fix: redefine the trigger function as SECURITY DEFINER and own it as
-- `gatewaze_module_writer`, the role that owns the queue table. The trigger
-- then runs with privileges sufficient to bypass RLS for the INSERT, but
-- still only writes the canonical (content_type, content_id, op) values
-- derived from the row that just changed.
-- ============================================================================

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_keyword_match_queue'
  ) THEN
    -- content-keywords not installed; nothing to fix.
    RAISE NOTICE '[events/009_fix_keyword_trigger_definer] content-keywords not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $migration$;

CREATE OR REPLACE FUNCTION public.events_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Skip cleanly if content-keywords was uninstalled after this trigger was
  -- attached to the events table.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_keyword_match_queue'
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('event', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'delete', enqueued_at = now(), next_attempt_at = now(),
            attempts = 0, last_error = NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('event', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op = 'evaluate', enqueued_at = now(), next_attempt_at = now(),
            attempts = 0, last_error = NULL;
    RETURN NEW;
  END IF;
END $$;

DO $own$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    ALTER FUNCTION public.events_ck_enqueue() OWNER TO gatewaze_module_writer;
  END IF;
END $own$;
