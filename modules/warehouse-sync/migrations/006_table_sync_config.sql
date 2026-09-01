-- ============================================================================
-- Module: warehouse-sync
-- Migration: 006_table_sync_config
-- Description: Operator-facing, per-table sync configuration edited from the
--   admin (Tables tab) — the desired state the module reconciles into Airbyte.
--   Airbyte schedules are per-connection, so per-table frequency is modelled as
--   frequency TIERS; the module maps tables → one Airbyte connection per active
--   tier (see lib/sync-planner.ts, api/register-routes.ts).
-- ============================================================================

-- Desired per-table config (one row per in-scope source table).
CREATE TABLE IF NOT EXISTS public.warehouse_sync_table_config (
  table_name    text PRIMARY KEY,                       -- source stream name (e.g. 'people')
  namespace     text NOT NULL DEFAULT 'public',
  enabled       boolean NOT NULL DEFAULT false,
  sync_mode     text NOT NULL DEFAULT 'incremental'
                 CHECK (sync_mode IN ('incremental','full_refresh')),
  frequency     text NOT NULL DEFAULT 'realtime'
                 CHECK (frequency IN ('realtime','hourly','daily')),
  cursor_field  text,                                   -- for cursor-based incremental (e.g. updated_at)
  primary_key   text,                                   -- for incremental dedupe
  use_cdc       boolean NOT NULL DEFAULT false,         -- log-based CDC vs cursor incremental
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);

COMMENT ON TABLE public.warehouse_sync_table_config IS
  'Desired per-table sync config edited in the admin Tables tab; reconciled into Airbyte connections by frequency tier.';

-- Tier → Airbyte connection mapping + the schedule the module applies to each.
CREATE TABLE IF NOT EXISTS public.warehouse_sync_tiers (
  frequency      text PRIMARY KEY
                  CHECK (frequency IN ('realtime','hourly','daily')),
  connection_id  text,                                  -- Airbyte connectionId managing this tier
  schedule_json  jsonb,                                  -- the Airbyte schedule applied (basic/cron)
  last_reconciled_at timestamptz,
  reconcile_error text
);

-- Seed the three tiers with sensible default schedules (tune in module config).
INSERT INTO public.warehouse_sync_tiers (frequency, schedule_json) VALUES
  ('realtime', '{"scheduleType":"basic","basicSchedule":{"timeUnit":"minutes","units":5}}'::jsonb),
  ('hourly',   '{"scheduleType":"basic","basicSchedule":{"timeUnit":"hours","units":1}}'::jsonb),
  ('daily',    '{"scheduleType":"cron","cronExpression":"0 0 3 * * ?","cronTimeZone":"UTC"}'::jsonb)
ON CONFLICT (frequency) DO NOTHING;

-- RLS: writes/reads go through the module API (service_role, which bypasses RLS).
-- Enable RLS with no public policy so no other authenticated user can read/write.
ALTER TABLE public.warehouse_sync_table_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_sync_tiers        ENABLE ROW LEVEL SECURITY;
