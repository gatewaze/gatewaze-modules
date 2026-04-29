-- =============================================================================
-- Module: events
-- Migration: 010_tenancy_v2
-- Description: tenant-scoped (account_id) RLS for events,
--              events_registrations, and events_attendance, gated on the
--              global tenancy_v2_enforced flag set by the gatewaze core
--              migration 00024_tenancy_v2_helpers.sql.
--
-- This migration is no-op for runtime behaviour while the flag is false
-- (the default). The legacy "everyone can SELECT events" policy is
-- preserved for the flag-off path; the new account-scoped policy fires
-- only when the flag is on.
--
-- Depends on: gatewaze core 00024 (helper functions, flag, accounts_users
-- self-select policy).
-- =============================================================================

-- =============================================================================
-- STEP 1: events
-- =============================================================================
-- Existing legacy policies (kept, but gated on flag-off):
--   events_select_public  TO anon       USING (true)
--   events_select_admin   TO authenticated USING (true)            ← cross-tenant leak vector
--   events_insert_admin   TO authenticated WITH CHECK is_super_admin()
--   events_update_admin   TO authenticated USING can_admin_event(id)
--   events_delete_admin   TO authenticated USING is_super_admin()

DROP POLICY IF EXISTS "events_select_admin" ON public.events;
DROP POLICY IF EXISTS "events_insert_admin" ON public.events;
DROP POLICY IF EXISTS "events_update_admin" ON public.events;
DROP POLICY IF EXISTS "events_delete_admin" ON public.events;

-- v1 (flag off) — preserves prior behaviour for authenticated users.
CREATE POLICY "events_select_authenticated_v1"
  ON public.events FOR SELECT TO authenticated
  USING (NOT public.tenancy_v2_enforced());

CREATE POLICY "events_insert_super_admin_v1"
  ON public.events FOR INSERT TO authenticated
  WITH CHECK (NOT public.tenancy_v2_enforced() AND public.is_super_admin());

CREATE POLICY "events_update_admin_v1"
  ON public.events FOR UPDATE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.can_admin_event(id));

CREATE POLICY "events_delete_super_admin_v1"
  ON public.events FOR DELETE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.is_super_admin());

-- v2 (flag on) — account-scoped + super-admin override.
CREATE POLICY "events_select_v2"
  ON public.events FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (public.account_in_scope(account_id) OR public.is_super_admin())
  );

CREATE POLICY "events_insert_v2"
  ON public.events FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (public.account_in_scope(account_id) OR public.is_super_admin())
  );

CREATE POLICY "events_update_v2"
  ON public.events FOR UPDATE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      (public.account_in_scope(account_id) AND public.can_admin_event(id))
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (public.account_in_scope(account_id) OR public.is_super_admin())
  );

CREATE POLICY "events_delete_v2"
  ON public.events FOR DELETE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      (public.account_in_scope(account_id) AND public.is_super_admin())
      OR public.is_super_admin()
    )
  );

-- service_role bypass.
CREATE POLICY "events_service_role"
  ON public.events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- The events_select_public TO anon USING (true) policy is intentionally
-- left unchanged. Public portal pages (event landing, RSVP) read events
-- as anon; tenant scoping at the DB layer is not the right control for
-- public reads (the brand-host mapping in the portal is). Phase 4 will
-- revisit this separately if needed.

-- =============================================================================
-- STEP 2: events_registrations
-- =============================================================================
-- Existing legacy policies are kept and gated. The v2 path scopes via the
-- parent event's account_id (registrations don't have their own
-- account_id column).

DROP POLICY IF EXISTS "registrations_select_own"     ON public.events_registrations;
DROP POLICY IF EXISTS "registrations_insert_self"    ON public.events_registrations;
DROP POLICY IF EXISTS "registrations_insert_admin"   ON public.events_registrations;
DROP POLICY IF EXISTS "registrations_update_admin"   ON public.events_registrations;
DROP POLICY IF EXISTS "registrations_delete_admin"   ON public.events_registrations;

-- v1 — preserves legacy behaviour.
CREATE POLICY "registrations_select_v1"
  ON public.events_registrations FOR SELECT TO authenticated
  USING (
    NOT public.tenancy_v2_enforced()
    AND (
      person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
      OR public.can_admin_event(event_id)
    )
  );

CREATE POLICY "registrations_insert_self_v1"
  ON public.events_registrations FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.tenancy_v2_enforced()
    AND person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
  );

CREATE POLICY "registrations_insert_admin_v1"
  ON public.events_registrations FOR INSERT TO authenticated
  WITH CHECK (NOT public.tenancy_v2_enforced() AND public.can_admin_event(event_id));

CREATE POLICY "registrations_update_admin_v1"
  ON public.events_registrations FOR UPDATE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.can_admin_event(event_id));

CREATE POLICY "registrations_delete_admin_v1"
  ON public.events_registrations FOR DELETE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.is_super_admin());

-- v2 — account-scoped via parent event.
-- Helper: a registration is in-scope iff its parent event is in-scope.
-- We inline the join rather than introduce yet another helper function.
CREATE POLICY "registrations_select_v2"
  ON public.events_registrations FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_registrations.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
      OR public.is_super_admin()
    )
  );

CREATE POLICY "registrations_insert_v2"
  ON public.events_registrations FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_registrations.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
      OR public.is_super_admin()
    )
  );

CREATE POLICY "registrations_update_v2"
  ON public.events_registrations FOR UPDATE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_registrations.event_id
          AND public.account_in_scope(e.account_id)
          AND public.can_admin_event(e.id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_registrations.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "registrations_delete_v2"
  ON public.events_registrations FOR DELETE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_registrations.event_id
          AND public.account_in_scope(e.account_id)
      )
      AND public.is_super_admin()
    )
  );

CREATE POLICY "registrations_service_role"
  ON public.events_registrations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- STEP 3: events_attendance
-- =============================================================================

DROP POLICY IF EXISTS "attendance_select" ON public.events_attendance;
DROP POLICY IF EXISTS "attendance_insert" ON public.events_attendance;
DROP POLICY IF EXISTS "attendance_update" ON public.events_attendance;
DROP POLICY IF EXISTS "attendance_delete" ON public.events_attendance;

CREATE POLICY "attendance_select_v1"
  ON public.events_attendance FOR SELECT TO authenticated
  USING (
    NOT public.tenancy_v2_enforced()
    AND (
      person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
      OR public.can_admin_event(event_id)
    )
  );

CREATE POLICY "attendance_insert_v1"
  ON public.events_attendance FOR INSERT TO authenticated
  WITH CHECK (NOT public.tenancy_v2_enforced() AND public.can_admin_event(event_id));

CREATE POLICY "attendance_update_v1"
  ON public.events_attendance FOR UPDATE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.can_admin_event(event_id));

CREATE POLICY "attendance_delete_v1"
  ON public.events_attendance FOR DELETE TO authenticated
  USING (NOT public.tenancy_v2_enforced() AND public.can_admin_event(event_id));

-- v2 — account-scoped via parent event.
CREATE POLICY "attendance_select_v2"
  ON public.events_attendance FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_attendance.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR person_id = (SELECT c.id FROM public.people c WHERE c.auth_user_id = auth.uid())
      OR public.is_super_admin()
    )
  );

CREATE POLICY "attendance_insert_v2"
  ON public.events_attendance FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_attendance.event_id
          AND public.account_in_scope(e.account_id)
          AND public.can_admin_event(e.id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "attendance_update_v2"
  ON public.events_attendance FOR UPDATE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_attendance.event_id
          AND public.account_in_scope(e.account_id)
          AND public.can_admin_event(e.id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_attendance.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "attendance_delete_v2"
  ON public.events_attendance FOR DELETE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_attendance.event_id
          AND public.account_in_scope(e.account_id)
          AND public.can_admin_event(e.id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "attendance_service_role"
  ON public.events_attendance FOR ALL TO service_role
  USING (true) WITH CHECK (true);
