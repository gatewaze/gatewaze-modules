-- ============================================================================
-- Migration: templates_011_writes_via_host
-- Description: INSERT / UPDATE / DELETE policies on the templates_* tables,
--              gated by the same host-dispatched permission helper that
--              the read policies use.
--
-- Background:
--   005_templates_rls.sql shipped read policies but no write policies — the
--   plan was for writes to go through API handlers that use service_role.
--   The newsletter cutover (PR 16.b/c) writes directly from the admin UI
--   client (using the user's auth session), so without write policies all
--   writes are RLS-denied.
--
--   Per discussion: option (1) — add direct-write policies that delegate
--   to the same dispatcher. Mirrors how legacy newsletters_block_templates
--   handled writes (`WITH CHECK (public.is_admin())`).
--
--   service_role still bypasses RLS, so platform workers + service-side
--   admin endpoints continue to work unchanged.
--
-- Tables covered:
--   - templates_libraries           (host_kind/host_id direct)
--   - templates_block_defs          (library_id)
--   - templates_brick_defs          (parent block_def's library_id)
--   - templates_wrappers            (library_id)
--   - templates_definitions         (library_id)
--   - templates_sources             (library_id)
--   - templates_source_artifacts    (parent source's library_id)
--   - templates_source_previews     (parent source's library_id)
--   - templates_ab_tests            (host_kind/host_id direct)
--   - templates_ab_assignments      (parent test's host_kind/host_id)
--   - templates_ab_events           (parent test's host_kind/host_id)
--
-- All policies use the SAME helper as the read policies — meaning a host's
-- can_admin_fn is also the canonical write-permission check.
-- A future per-table separation (e.g., can_view_block_defs vs.
-- can_edit_block_defs) would split the dispatcher into a "permission
-- level" parameter; for v0.1 read-and-write share one ACL.
-- ============================================================================

-- ==========================================================================
-- templates_libraries
-- ==========================================================================
-- INSERT — caller must be able to admin (host_kind, host_id) of NEW row
CREATE POLICY "templates_libraries_insert_via_host"
  ON public.templates_libraries
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_host(host_kind, host_id));

-- UPDATE — caller must admin BOTH old and new (host_kind, host_id)
-- (i.e., re-homing a library across hosts requires admin on both ends)
CREATE POLICY "templates_libraries_update_via_host"
  ON public.templates_libraries
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id))
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "templates_libraries_delete_via_host"
  ON public.templates_libraries
  FOR DELETE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

-- ==========================================================================
-- templates_block_defs
-- ==========================================================================
CREATE POLICY "templates_block_defs_insert_via_host"
  ON public.templates_block_defs
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_block_defs_update_via_host"
  ON public.templates_block_defs
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(library_id))
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_block_defs_delete_via_host"
  ON public.templates_block_defs
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(library_id));

-- ==========================================================================
-- templates_brick_defs (parented by block_def_id)
-- ==========================================================================
-- The parent's library_id is required for the dispatcher. PostgreSQL
-- evaluates CASCADE deletes against per-row policies; the parent row
-- still exists at the moment the brick_defs row is being deleted, so the
-- subquery resolves correctly during cascade.

CREATE POLICY "templates_brick_defs_insert_via_host"
  ON public.templates_brick_defs
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_block_defs WHERE id = templates_brick_defs.block_def_id)
  ));

CREATE POLICY "templates_brick_defs_update_via_host"
  ON public.templates_brick_defs
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_block_defs WHERE id = templates_brick_defs.block_def_id)
  ))
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_block_defs WHERE id = templates_brick_defs.block_def_id)
  ));

CREATE POLICY "templates_brick_defs_delete_via_host"
  ON public.templates_brick_defs
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_block_defs WHERE id = templates_brick_defs.block_def_id)
  ));

-- ==========================================================================
-- templates_wrappers
-- ==========================================================================
CREATE POLICY "templates_wrappers_insert_via_host"
  ON public.templates_wrappers
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_wrappers_update_via_host"
  ON public.templates_wrappers
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(library_id))
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_wrappers_delete_via_host"
  ON public.templates_wrappers
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(library_id));

-- ==========================================================================
-- templates_definitions
-- ==========================================================================
CREATE POLICY "templates_definitions_insert_via_host"
  ON public.templates_definitions
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_definitions_update_via_host"
  ON public.templates_definitions
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(library_id))
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_definitions_delete_via_host"
  ON public.templates_definitions
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(library_id));

-- ==========================================================================
-- templates_sources
-- ==========================================================================
CREATE POLICY "templates_sources_insert_via_host"
  ON public.templates_sources
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_sources_update_via_host"
  ON public.templates_sources
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(library_id))
  WITH CHECK (templates.can_read_library(library_id));

CREATE POLICY "templates_sources_delete_via_host"
  ON public.templates_sources
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(library_id));

-- ==========================================================================
-- templates_source_artifacts (parented by source_id)
-- ==========================================================================
CREATE POLICY "templates_source_artifacts_insert_via_host"
  ON public.templates_source_artifacts
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_artifacts.source_id)
  ));

CREATE POLICY "templates_source_artifacts_update_via_host"
  ON public.templates_source_artifacts
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_artifacts.source_id)
  ))
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_artifacts.source_id)
  ));

CREATE POLICY "templates_source_artifacts_delete_via_host"
  ON public.templates_source_artifacts
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_artifacts.source_id)
  ));

-- ==========================================================================
-- templates_source_previews (parented by source_id)
-- ==========================================================================
CREATE POLICY "templates_source_previews_insert_via_host"
  ON public.templates_source_previews
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_previews.source_id)
  ));

CREATE POLICY "templates_source_previews_update_via_host"
  ON public.templates_source_previews
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_previews.source_id)
  ))
  WITH CHECK (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_previews.source_id)
  ));

CREATE POLICY "templates_source_previews_delete_via_host"
  ON public.templates_source_previews
  FOR DELETE
  TO authenticated
  USING (templates.can_read_library(
    (SELECT library_id FROM public.templates_sources WHERE id = templates_source_previews.source_id)
  ));

-- ==========================================================================
-- templates_ab_tests (host_kind/host_id direct)
-- ==========================================================================
CREATE POLICY "templates_ab_tests_insert_via_host"
  ON public.templates_ab_tests
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "templates_ab_tests_update_via_host"
  ON public.templates_ab_tests
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id))
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "templates_ab_tests_delete_via_host"
  ON public.templates_ab_tests
  FOR DELETE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

-- ==========================================================================
-- templates_ab_assignments (parented by test_id)
-- ==========================================================================
CREATE POLICY "templates_ab_assignments_insert_via_host"
  ON public.templates_ab_assignments
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id)
  ));

CREATE POLICY "templates_ab_assignments_update_via_host"
  ON public.templates_ab_assignments
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id)
  ))
  WITH CHECK (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id)
  ));

CREATE POLICY "templates_ab_assignments_delete_via_host"
  ON public.templates_ab_assignments
  FOR DELETE
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_assignments.test_id)
  ));

-- ==========================================================================
-- templates_ab_events (parented by test_id)
-- ==========================================================================
CREATE POLICY "templates_ab_events_insert_via_host"
  ON public.templates_ab_events
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id)
  ));

CREATE POLICY "templates_ab_events_update_via_host"
  ON public.templates_ab_events
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id)
  ))
  WITH CHECK (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id)
  ));

CREATE POLICY "templates_ab_events_delete_via_host"
  ON public.templates_ab_events
  FOR DELETE
  TO authenticated
  USING (templates.can_read_host(
    (SELECT host_kind FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id),
    (SELECT host_id   FROM public.templates_ab_tests WHERE id = templates_ab_events.test_id)
  ));
