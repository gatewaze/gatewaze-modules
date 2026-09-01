-- ============================================================================
-- Module: warehouse-sync
-- Migration: 005_airbyte_status
-- Description: Airbyte control-plane bookkeeping (Option B). The airbyte-status
--   worker polls the central Airbyte's public API (scoped to this instance's
--   workspace) and upserts the latest sync state per connection here, so the
--   CDC-Health dashboard shows Airbyte sync health next to the slot health —
--   without the admin app calling Airbyte directly on every render.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_sync_airbyte_connections (
  connection_id    text PRIMARY KEY,
  name             text NOT NULL,
  status           text,                    -- active | inactive | deprecated
  last_job_id      bigint,
  last_job_status  text,                    -- succeeded | running | failed | …
  last_job_at      timestamptz,
  rows_synced      bigint,
  bytes_synced     bigint,
  last_error       text,
  observed_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.warehouse_sync_airbyte_connections IS
  'Latest Airbyte sync state per connection for this instance's workspace (Option B control plane). Refreshed by warehouse-sync:airbyte-status.';

CREATE INDEX IF NOT EXISTS warehouse_sync_airbyte_conn_failed
  ON public.warehouse_sync_airbyte_connections (last_job_status)
  WHERE last_job_status = 'failed';
