-- Customer.io Module: Sync Tables
-- Migration: 001_customerio_tables.sql
--
-- Tables for syncing data from Customer.io:
--   activities, segments, segment memberships, events,
--   relationships, sync status/jobs

-- 1. Customer activities
CREATE TABLE IF NOT EXISTS public.integrations_customerio_activities (
  id bigserial PRIMARY KEY,
  customer_cio_id text NOT NULL,
  activity_type text NOT NULL,
  activity_name text,
  activity_data jsonb DEFAULT '{}'::jsonb,
  timestamp timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_customerio_activities_cio_id ON public.integrations_customerio_activities(customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_activities_timestamp ON public.integrations_customerio_activities(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_activities_type ON public.integrations_customerio_activities(activity_type);

-- 2. Customer segments (from CIO)
CREATE TABLE IF NOT EXISTS public.integrations_customerio_segments (
  id bigserial PRIMARY KEY,
  cio_segment_id integer UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  type text,
  progress integer,
  tags text[],
  last_synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_customerio_segments_cio_id ON public.integrations_customerio_segments(cio_segment_id);

CREATE TRIGGER integrations_customerio_segments_updated_at
  BEFORE UPDATE ON public.integrations_customerio_segments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Customer segment memberships
CREATE TABLE IF NOT EXISTS public.integrations_customerio_segment_memberships (
  id bigserial PRIMARY KEY,
  customer_cio_id text NOT NULL,
  segment_id integer NOT NULL REFERENCES public.integrations_customerio_segments(cio_segment_id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  last_verified_at timestamptz DEFAULT now(),
  UNIQUE(customer_cio_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_customerio_segment_memberships_customer ON public.integrations_customerio_segment_memberships(customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_segment_memberships_segment ON public.integrations_customerio_segment_memberships(segment_id);

-- 4. Customer events (CIO events, not calendar events)
CREATE TABLE IF NOT EXISTS public.integrations_customerio_events (
  id bigserial PRIMARY KEY,
  customer_cio_id text NOT NULL,
  event_id text,
  event_name text NOT NULL,
  event_data jsonb DEFAULT '{}'::jsonb,
  timestamp timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_customerio_events_cio_id ON public.integrations_customerio_events(customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_events_name ON public.integrations_customerio_events(event_name);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_events_timestamp ON public.integrations_customerio_events(timestamp DESC);

-- 5. Customer relationships
CREATE TABLE IF NOT EXISTS public.integrations_customerio_relationships (
  id bigserial PRIMARY KEY,
  customer_cio_id text NOT NULL,
  object_type_id text NOT NULL,
  object_id text NOT NULL,
  relationship_attributes jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(customer_cio_id, object_type_id, object_id)
);

CREATE INDEX IF NOT EXISTS idx_integrations_customerio_relationships_cio_id ON public.integrations_customerio_relationships(customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_integrations_customerio_relationships_object ON public.integrations_customerio_relationships(object_type_id, object_id);

CREATE TRIGGER integrations_customerio_relationships_updated_at
  BEFORE UPDATE ON public.integrations_customerio_relationships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. CIO sync status
CREATE TABLE IF NOT EXISTS public.integrations_customerio_sync_status (
  id bigserial PRIMARY KEY,
  sync_type text UNIQUE NOT NULL,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  records_synced integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

INSERT INTO public.integrations_customerio_sync_status (sync_type, last_sync_status)
VALUES
  ('customers', 'pending'),
  ('segments', 'pending'),
  ('activities', 'pending'),
  ('events', 'pending'),
  ('relationships', 'pending')
ON CONFLICT (sync_type) DO NOTHING;

CREATE TRIGGER integrations_customerio_sync_status_updated_at
  BEFORE UPDATE ON public.integrations_customerio_sync_status
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 7. RLS
ALTER TABLE public.integrations_customerio_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_customerio_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_customerio_segment_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_customerio_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_customerio_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_customerio_sync_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_integrations_customerio_activities" ON public.integrations_customerio_activities FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_customerio_segments" ON public.integrations_customerio_segments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_customerio_segment_memberships" ON public.integrations_customerio_segment_memberships FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_customerio_events" ON public.integrations_customerio_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_customerio_relationships" ON public.integrations_customerio_relationships FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_integrations_customerio_sync_status" ON public.integrations_customerio_sync_status FOR ALL TO authenticated USING (true) WITH CHECK (true);
