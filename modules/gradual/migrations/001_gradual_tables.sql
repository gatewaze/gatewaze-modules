-- Gradual integration: sync jobs table
-- Tracks batch sync jobs for pushing registrations to the Gradual platform.

CREATE TABLE IF NOT EXISTS public.integrations_gradual_sync_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  gradual_eventslug       text,
  status                  text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_registrations     integer DEFAULT 0,
  processed_registrations integer DEFAULT 0,
  successful_syncs        integer DEFAULT 0,
  failed_syncs            integer DEFAULT 0,
  errors                  jsonb DEFAULT '[]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gradual_sync_jobs_event ON public.integrations_gradual_sync_jobs(event_id);
CREATE INDEX IF NOT EXISTS idx_gradual_sync_jobs_status ON public.integrations_gradual_sync_jobs(status);

CREATE TRIGGER integrations_gradual_sync_jobs_updated_at
  BEFORE UPDATE ON public.integrations_gradual_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Column on events_registrations to track which registrations have been synced
ALTER TABLE public.events_registrations
  ADD COLUMN IF NOT EXISTS gradual_synced_at timestamptz;

-- Column on events to link to a Gradual event slug
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS gradual_eventslug text;
