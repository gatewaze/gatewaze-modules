-- ============================================================================
-- Migration: templates_019_grant_table_privileges
-- Description: Grant table-level privileges on every templates_* table to
--              the authenticated + anon roles. Migration 012 granted USAGE
--              on the templates schema and EXECUTE on the dispatcher
--              functions, but never granted INSERT/SELECT/UPDATE/DELETE
--              on the tables themselves.
--
--              Without these grants the RLS policy is unreachable: the
--              role can't read or write the table at all, so PostgREST
--              answers 403 before the WITH CHECK / USING expression even
--              runs. Symptom: newsletter wizard's templates_libraries
--              insert fails with "permission denied" / "403 Forbidden",
--              and the newsletter ends up half-created.
--
--              Idempotent. Targets every public.templates_* relation that
--              exists at apply time (so brands that have added their own
--              templates_* tables also get covered).
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'templates_%'
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
      t
    );
    EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
  END LOOP;
END
$$;

-- Future templates_* tables added by later migrations should re-run this
-- block (or include their own GRANT). ALTER DEFAULT PRIVILEGES on
-- schema=public would be too broad — it would grant on every new public
-- table, not just templates_*.
