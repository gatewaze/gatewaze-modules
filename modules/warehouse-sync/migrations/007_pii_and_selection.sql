-- ============================================================================
-- Module: warehouse-sync
-- Migration: 007_pii_and_selection
-- Description: Per-table PII posture for column-level redaction (§8.2).
--   include_pii = true  → replicate the full row ("exactly as in Supabase"),
--                         the production posture.
--   include_pii = false → the reconcile restricts the Airbyte stream to the
--                         non-PII columns (selectedFields), so personal data
--                         never leaves Supabase — the default for test/non-prod
--                         destinations.
-- ============================================================================

ALTER TABLE public.warehouse_sync_table_config
  ADD COLUMN IF NOT EXISTS include_pii boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.warehouse_sync_table_config.include_pii IS
  'true = replicate full row (prod). false = redact PII columns via Airbyte selectedFields (test).';
