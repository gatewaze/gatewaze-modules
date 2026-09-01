-- ============================================================================
-- Module: warehouse-sync
-- Migration: 003_source_prerequisites
-- Description: Supabase source-side prerequisites (§10) — the scoped CDC
--   publication and least-privilege Postgres roles.
--
--   ⚠️  OPT-IN BY DESIGN. These are production DBA operations (REPLICATION,
--   BYPASSRLS, a publication that will anchor a WAL-retaining slot — §10.4).
--   They must NOT run implicitly during a routine `modules:migrate`. The whole
--   migration is a NO-OP unless the operator explicitly opts in for the session:
--
--       SET warehouse_sync.apply_source_prereqs = 'on';
--       \i migrations/003_source_prerequisites.sql
--
--   No secret is embedded. The reader role is created with PASSWORD NULL
--   (cannot log in) — set it out of band from the LF secret store (§13):
--
--       ALTER ROLE snowflake_reader WITH PASSWORD '<from-secret-store>';
--
--   The table list MUST match manifest/appendix-a.yaml. It is generated-aligned;
--   regenerate the canonical publication SQL with `pnpm generate:sql` and diff.
-- ============================================================================

DO $prereqs$
DECLARE
  v_optin text := current_setting('warehouse_sync.apply_source_prereqs', true);
BEGIN
  IF v_optin IS DISTINCT FROM 'on' THEN
    RAISE NOTICE '[warehouse-sync/003] skipped — set "warehouse_sync.apply_source_prereqs = ''on''" to apply source prerequisites (§10).';
    RETURN;
  END IF;

  -- ── Roles (§10.2, §10.4, §12.3) ─────────────────────────────────────────
  -- Extraction role: LOGIN REPLICATION BYPASSRLS, otherwise minimal (§8.4).
  BEGIN
    CREATE ROLE snowflake_reader WITH
      LOGIN REPLICATION BYPASSRLS
      NOSUPERUSER NOCREATEDB NOCREATEROLE
      PASSWORD NULL;
    RAISE NOTICE '[warehouse-sync/003] created role snowflake_reader (PASSWORD NULL — set it from the secret store).';
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE '[warehouse-sync/003] role snowflake_reader already exists — leaving as-is.';
  END;

  -- Slot monitor: read-only stats, NO table SELECT (§10.4 control #1). The
  -- Gatewaze worker uses service_role via the SECURITY DEFINER RPC, but this
  -- role exists for any external/trusted monitor that needs direct access.
  BEGIN
    CREATE ROLE snowflake_slot_monitor WITH
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      PASSWORD NULL;
    RAISE NOTICE '[warehouse-sync/003] created role snowflake_slot_monitor.';
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE '[warehouse-sync/003] role snowflake_slot_monitor already exists.';
  END;

  -- The pg_read_all_stats grant is OPTIONAL and isolated in its own block: on
  -- managed Postgres (e.g. Supabase) the bootstrap "postgres" superuser is not a
  -- member of pg_read_all_stats WITH ADMIN OPTION, so it cannot grant it, and an
  -- uncaught insufficient_privilege here would roll back the whole DO block
  -- (taking snowflake_reader + the publication with it). The Gatewaze slot-monitor
  -- worker reads slot stats via the SECURITY DEFINER RPC (migration 002), so this
  -- role is auxiliary — only an external/trusted direct monitor needs the grant.
  BEGIN
    GRANT pg_read_all_stats TO snowflake_slot_monitor;
    RAISE NOTICE '[warehouse-sync/003] granted pg_read_all_stats to snowflake_slot_monitor.';
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE '[warehouse-sync/003] SKIP pg_read_all_stats grant (insufficient privilege on managed Postgres) — the worker uses the SECURITY DEFINER RPC for slot stats.';
  END;

  -- Verifier: SELECT-only, for the warehouse reconciliation counts (§12.3).
  -- No REPLICATION, no BYPASSRLS.
  BEGIN
    CREATE ROLE snowflake_verifier WITH
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD NULL;
    RAISE NOTICE '[warehouse-sync/003] created role snowflake_verifier.';
  EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE '[warehouse-sync/003] role snowflake_verifier already exists.';
  END;

  -- ── Conservative safety timeouts (§10.2) ─────────────────────────────────
  ALTER ROLE snowflake_reader SET statement_timeout = '30min';
  ALTER ROLE snowflake_reader SET idle_in_transaction_session_timeout = '1min';
  ALTER ROLE snowflake_verifier SET statement_timeout = '5min';

  -- ── Grants + publication (§10.1, §10.2) ──────────────────────────────────
  -- Explicit intended list (§8.1, manifest appendix-a); do NOT blanket-grant
  -- future tables. Applied to the subset that ACTUALLY exists on this instance —
  -- table names vary per deployment (a table may be renamed or not installed),
  -- and an absent one must NOT abort the whole DO block (which would roll back
  -- the roles + publication too). Missing tables are reported, not fatal.
  DECLARE
    v_intended text[] := ARRAY[
      'people','person_emails','people_events','events',
      'event_registrations','send_log','email_interactions','newsletter_sends'];
    v_present text[];
    v_missing text[];
    v_list    text;
  BEGIN
    SELECT array_agg(t ORDER BY t) INTO v_present
      FROM unnest(v_intended) AS t
      WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL;
    SELECT array_agg(t ORDER BY t) INTO v_missing
      FROM unnest(v_intended) AS t
      WHERE to_regclass('public.' || quote_ident(t)) IS NULL;

    IF v_present IS NULL THEN
      RAISE EXCEPTION '[warehouse-sync/003] none of the intended tables exist here — reconcile manifest/appendix-a.yaml with this instance''s schema.';
    END IF;

    SELECT string_agg('public.' || quote_ident(t), ', ' ORDER BY t)
      INTO v_list FROM unnest(v_present) AS t;

    GRANT USAGE ON SCHEMA public TO snowflake_reader, snowflake_verifier;
    EXECUTE 'GRANT SELECT ON ' || v_list || ' TO snowflake_reader';
    EXECUTE 'GRANT SELECT ON ' || v_list || ' TO snowflake_verifier';

    -- Publication — explicit table list, NOT "FOR ALL TABLES".
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'snowflake_cdc') THEN
      EXECUTE 'CREATE PUBLICATION snowflake_cdc FOR TABLE ' || v_list;
      RAISE NOTICE '[warehouse-sync/003] created publication snowflake_cdc for: %', v_list;
    ELSE
      RAISE NOTICE '[warehouse-sync/003] publication snowflake_cdc already exists — ALTER PUBLICATION to change scope (§8.1).';
    END IF;

    IF v_missing IS NOT NULL THEN
      RAISE NOTICE '[warehouse-sync/003] SKIPPED (absent on this instance): % — reconcile manifest/appendix-a.yaml table names before they can replicate.', array_to_string(v_missing, ', ');
    END IF;
  END;

  RAISE NOTICE '[warehouse-sync/003] NEXT: set snowflake_reader password from the secret store, confirm max_slot_wal_keep_size is bounded (§10.4 control #3), then point the connector at the DIRECT endpoint (§10.3) — NOT the pooler.';
END $prereqs$;
