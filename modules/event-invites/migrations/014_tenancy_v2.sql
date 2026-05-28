-- =============================================================================
-- Module: event-invites
-- Migration: 014_tenancy_v2
-- Description: dual-track v1/v2 RLS on the event-scoped invite tables.
--              Each table previously had a broad
--              `auth_all_<table> TO authenticated USING (true)` policy
--              — a cross-tenant leak vector. This migration replaces
--              those with v1 (legacy, gated on flag-off) and v2 (gated
--              on flag-on, scopes via parent event's account_id).
--
-- Depends on: gatewaze core 00024_tenancy_v2_helpers.sql for the
--             tenancy_v2_enforced(), account_in_scope(), and
--             user_account_ids() helper functions, plus the global
--             tenancy_v2_enforced flag.
--
-- Out of scope (deferred to follow-up): invite_templates,
-- invite_template_assets, invite_deliveries, invite_open_links,
-- invite_sub_events, invite_reminder_config, invite_reminder_log,
-- invite_questions, invite_party_members, invite_party_member_events,
-- calendars_invites, calendars_interactions. These are reachable from
-- event_invites or invite_parties; full tenancy coverage tracked in
-- spec-production-readiness-hardening §7.4.
-- =============================================================================

-- =============================================================================
-- STEP 1: event_invites (FK → events.id, FK → people_profiles.id)
-- =============================================================================

DROP POLICY IF EXISTS "auth_all_event_invites" ON public.event_invites;
DROP POLICY IF EXISTS "anon_select_event_invites" ON public.event_invites;
DROP POLICY IF EXISTS "anon_update_event_invites" ON public.event_invites;

-- v1 (flag off) — preserves prior `auth_all` behaviour for authenticated.
CREATE POLICY "event_invites_auth_v1"
  ON public.event_invites FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

-- v2 (flag on) — scope via parent event's account_id.
CREATE POLICY "event_invites_select_v2"
  ON public.event_invites FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invites.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invites_insert_v2"
  ON public.event_invites FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invites.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invites_update_v2"
  ON public.event_invites FOR UPDATE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invites.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invites.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invites_delete_v2"
  ON public.event_invites FOR DELETE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invites.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- anon select/update by token: this is the public RSVP path. Tenancy
-- doesn't apply at the DB layer for token-presenting requests; the
-- token itself is the authorization. Reinstate the prior policies
-- unchanged.
CREATE POLICY "event_invites_anon_select"
  ON public.event_invites FOR SELECT TO anon
  USING (true);

CREATE POLICY "event_invites_anon_update"
  ON public.event_invites FOR UPDATE TO anon
  USING (true);

-- service_role bypass.
CREATE POLICY "event_invites_service_role"
  ON public.event_invites FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- STEP 2: event_invite_batches (FK → events.id)
-- =============================================================================

DROP POLICY IF EXISTS "auth_all_event_invite_batches" ON public.event_invite_batches;

CREATE POLICY "event_invite_batches_auth_v1"
  ON public.event_invite_batches FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

CREATE POLICY "event_invite_batches_select_v2"
  ON public.event_invite_batches FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invite_batches.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invite_batches_insert_v2"
  ON public.event_invite_batches FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invite_batches.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invite_batches_update_v2"
  ON public.event_invite_batches FOR UPDATE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invite_batches.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invite_batches.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invite_batches_delete_v2"
  ON public.event_invite_batches FOR DELETE TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = event_invite_batches.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invite_batches_service_role"
  ON public.event_invite_batches FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- STEP 3: event_invite_interactions (FK → event_invites.id)
-- =============================================================================
-- Scope via the parent invite (which scopes via its parent event).

DROP POLICY IF EXISTS "auth_all_event_invite_interactions" ON public.event_invite_interactions;
DROP POLICY IF EXISTS "anon_insert_event_invite_interactions" ON public.event_invite_interactions;
DROP POLICY IF EXISTS "authenticated_all_event_invite_interactions" ON public.event_invite_interactions;

CREATE POLICY "event_invite_interactions_auth_v1"
  ON public.event_invite_interactions FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

CREATE POLICY "event_invite_interactions_select_v2"
  ON public.event_invite_interactions FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1
        FROM public.event_invites i
        JOIN public.events e ON e.id = i.event_id
        WHERE i.id = event_invite_interactions.invite_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "event_invite_interactions_insert_v2"
  ON public.event_invite_interactions FOR INSERT TO authenticated
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1
        FROM public.event_invites i
        JOIN public.events e ON e.id = i.event_id
        WHERE i.id = event_invite_interactions.invite_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- anon insert: open-link clicks happen unauthenticated. Reinstate the
-- prior anon insert policy unchanged.
CREATE POLICY "event_invite_interactions_anon_insert"
  ON public.event_invite_interactions FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "event_invite_interactions_service_role"
  ON public.event_invite_interactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- STEP 4: invite_parties (FK → events.id)
-- =============================================================================

DROP POLICY IF EXISTS "authenticated_select_invite_parties" ON public.invite_parties;
DROP POLICY IF EXISTS "authenticated_all_invite_parties"    ON public.invite_parties;

CREATE POLICY "invite_parties_auth_v1"
  ON public.invite_parties FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

CREATE POLICY "invite_parties_select_v2"
  ON public.invite_parties FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = invite_parties.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "invite_parties_modify_v2"
  ON public.invite_parties FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = invite_parties.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = invite_parties.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "invite_parties_service_role"
  ON public.invite_parties FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =============================================================================
-- STEP 5: invite_responses (FK → invite_questions.id, indirectly to invite)
-- =============================================================================
-- We scope via the invite the response belongs to. invite_responses has
-- invite_id (FK → event_invites.id) per migration 003.

DROP POLICY IF EXISTS "authenticated_all_invite_responses" ON public.invite_responses;

CREATE POLICY "invite_responses_auth_v1"
  ON public.invite_responses FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

CREATE POLICY "invite_responses_select_v2"
  ON public.invite_responses FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1
        FROM public.event_invites i
        JOIN public.events e ON e.id = i.event_id
        WHERE i.id = invite_responses.invite_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "invite_responses_modify_v2"
  ON public.invite_responses FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1
        FROM public.event_invites i
        JOIN public.events e ON e.id = i.event_id
        WHERE i.id = invite_responses.invite_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1
        FROM public.event_invites i
        JOIN public.events e ON e.id = i.event_id
        WHERE i.id = invite_responses.invite_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

-- anon: the public RSVP form posts answers; allow anon insert (the
-- application validates the invite token) — token is the authorization.
CREATE POLICY "invite_responses_anon_insert"
  ON public.invite_responses FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "invite_responses_service_role"
  ON public.invite_responses FOR ALL TO service_role
  USING (true) WITH CHECK (true);
