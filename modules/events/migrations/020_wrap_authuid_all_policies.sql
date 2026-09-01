-- ============================================================================
-- Platform-wide RLS perf: wrap every bare auth.uid() as (SELECT auth.uid())
-- ============================================================================
-- Follow-up to 019 (which fixed the events_registrations policies). ~75 policies
-- across many tables (ambassador_*, onboarding_*, live_chat_*, events_attendance,
-- calendars_*, person_member_organizations, lists, replies, speaker_*, …) compare
-- a column to a BARE auth.uid(). Written bare, that STABLE current_setting()
-- expression is re-evaluated per row and won't be used as an index condition —
-- policies that resolve the owner via `people WHERE auth_user_id = auth.uid()`
-- then SEQ-SCAN the 159k-row people table (~7s) and time out under the
-- authenticated (8s) / anon (3s) statement_timeout.
--
-- Wrapping as `(SELECT auth.uid())` makes it a one-time InitPlan constant (the
-- Supabase-documented fix), enabling index use. Semantically identical — only
-- evaluation changes. This was applied to AAIF prod directly; this migration
-- makes it durable and idempotent (re-running wraps only still-bare occurrences).
--
-- NOTE: best-effort across the schema — it wraps every public policy that exists
-- when it runs. On a fresh install, a policy created by a LATER-ordered migration
-- won't be caught here; author new policies with (SELECT auth.uid()) directly.

DO $$
DECLARE
  r        record;
  wrapped  constant text := '\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+\w+)?\s*\)';
  nq       text;
  nw       text;
  clauses  text;
BEGIN
  FOR r IN
    SELECT cl.relname AS tbl, p.polname AS name,
           pg_get_expr(p.polqual, p.polrelid)      AS q,
           pg_get_expr(p.polwithcheck, p.polrelid) AS w
    FROM pg_policy p
    JOIN pg_class cl     ON cl.oid = p.polrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    clauses := '';

    -- USING clause has a bare auth.uid()? (bare = present after removing wrapped forms)
    IF r.q IS NOT NULL AND regexp_replace(r.q, wrapped, '', 'gi') ~* 'auth\.uid\(\)' THEN
      nq := regexp_replace(r.q, wrapped, 'WRAPPEDTOKEN', 'gi');
      nq := regexp_replace(nq, 'auth\.uid\(\)', '(SELECT auth.uid())', 'gi');
      nq := replace(nq, 'WRAPPEDTOKEN', '(SELECT auth.uid())');
      clauses := clauses || ' USING (' || nq || ')';
    END IF;

    -- WITH CHECK clause has a bare auth.uid()?
    IF r.w IS NOT NULL AND regexp_replace(r.w, wrapped, '', 'gi') ~* 'auth\.uid\(\)' THEN
      nw := regexp_replace(r.w, wrapped, 'WRAPPEDTOKEN', 'gi');
      nw := regexp_replace(nw, 'auth\.uid\(\)', '(SELECT auth.uid())', 'gi');
      nw := replace(nw, 'WRAPPEDTOKEN', '(SELECT auth.uid())');
      clauses := clauses || ' WITH CHECK (' || nw || ')';
    END IF;

    IF clauses <> '' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I%s', r.name, r.tbl, clauses);
      RAISE NOTICE 'wrapped auth.uid() in policy %.%', r.tbl, r.name;
    END IF;
  END LOOP;
END $$;
