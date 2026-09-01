-- ============================================================================
-- events_registrations RLS perf: wrap auth.uid() + index people.auth_user_id
-- ============================================================================
-- Deleting/reading an event registration via PostgREST (authenticated role) timed
-- out (57014). Root cause: the registration RLS policies match the owner with
--   person_id = (SELECT id FROM people WHERE auth_user_id = auth.uid())
-- and `auth.uid()` (a STABLE current_setting() expression) written bare is
-- re-evaluated per row and NOT used as an index condition — so the subquery
-- SEQ-SCANS the 159k-row people table (~7s), right at the authenticated role's
-- 8s statement_timeout (anon's is 3s). The Supabase-documented fix is to wrap it
-- as `(SELECT auth.uid())`, which the planner treats as a one-time InitPlan
-- constant so an index on people.auth_user_id can be used. Result: ~7s → ~75ms.
--
-- Semantically identical — this only changes evaluation, not which rows match.
-- (There are ~20 more policies across other tables with the same bare-auth.uid()
--  -> people pattern; those are a separate follow-up.)

-- A general (non-partial) index for the owner lookup. The pre-existing partial
-- index (…WHERE linkedin_url<>'') can't serve the RLS subquery.
CREATE INDEX IF NOT EXISTS idx_people_auth_user_id ON public.people (auth_user_id);

-- Wrap auth.uid() in the four registration policies that join people. ALTER
-- POLICY preserves each policy's roles + command; only the expression changes.
ALTER POLICY registrations_select_v1 ON public.events_registrations
  USING ((NOT tenancy_v2_enforced())
     AND ((person_id = (SELECT c.id FROM people c WHERE c.auth_user_id = (SELECT auth.uid())))
          OR can_admin_event(event_id)));

ALTER POLICY registrations_select_v2 ON public.events_registrations
  USING (tenancy_v2_enforced()
     AND ((EXISTS (SELECT 1 FROM events e WHERE e.id = events_registrations.event_id AND account_in_scope(e.account_id)))
          OR (person_id = (SELECT c.id FROM people c WHERE c.auth_user_id = (SELECT auth.uid())))
          OR is_super_admin()));

ALTER POLICY registrations_insert_self_v1 ON public.events_registrations
  WITH CHECK ((NOT tenancy_v2_enforced())
          AND (person_id = (SELECT c.id FROM people c WHERE c.auth_user_id = (SELECT auth.uid()))));

ALTER POLICY registrations_insert_v2 ON public.events_registrations
  WITH CHECK (tenancy_v2_enforced()
          AND ((EXISTS (SELECT 1 FROM events e WHERE e.id = events_registrations.event_id AND account_in_scope(e.account_id)))
               OR (person_id = (SELECT c.id FROM people c WHERE c.auth_user_id = (SELECT auth.uid())))
               OR is_super_admin()));
