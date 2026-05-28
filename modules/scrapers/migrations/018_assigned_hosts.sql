-- ============================================================================
-- scrapers — assigned hosts
-- Lets admins manually assign people from the CRM as hosts on an event,
-- alongside the auto-discovered Luma hosts in event_host_events.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.events_assigned_hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  role          text,
  notes         text,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid,
  UNIQUE (event_id, person_id)
);

CREATE INDEX IF NOT EXISTS events_assigned_hosts_event ON public.events_assigned_hosts(event_id);
CREATE INDEX IF NOT EXISTS events_assigned_hosts_person ON public.events_assigned_hosts(person_id);

DO $grants$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
  ALTER TABLE public.events_assigned_hosts OWNER TO gatewaze_module_writer;
END $grants$;

ALTER TABLE public.events_assigned_hosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eah_service ON public.events_assigned_hosts;
CREATE POLICY eah_service ON public.events_assigned_hosts FOR ALL
  TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS eah_authenticated_read ON public.events_assigned_hosts;
CREATE POLICY eah_authenticated_read ON public.events_assigned_hosts FOR SELECT
  TO authenticated USING (true);
