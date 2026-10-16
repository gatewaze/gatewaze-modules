-- ============================================================================
-- Migration: templates_030_service_role_schema_usage
-- Description: Let the service role call the one `templates` helper that
--              row triggers need.
--
-- 012 granted USAGE on the schema (and EXECUTE on the dispatchers) to
-- `authenticated` and `anon` only. Row triggers on page_blocks /
-- page_block_bricks call `templates.walk_media_urls(...)` as the invoking
-- role (they are not SECURITY DEFINER), so any service-role write to those
-- tables that does not go through a SECURITY DEFINER RPC fails with
-- "permission denied for schema templates". The sites module's LFX importer
-- inserts page_blocks directly with the service-role client; so would any
-- future seed or backfill.
--
-- Scoped to USAGE + that one function on purpose: the service role already
-- bypasses RLS, so nothing else in the schema needs to be reachable.
-- Idempotent.
-- ============================================================================

GRANT USAGE ON SCHEMA templates TO service_role;
GRANT EXECUTE ON FUNCTION templates.walk_media_urls(jsonb, jsonb) TO service_role;
