-- ============================================================================
-- Migration: sites_008_writes_via_admin
-- Description: Make sites usable from the admin UI.
--
-- Fixes two gaps in 005_sites_rls.sql:
--   1. public.can_admin_site() was a stub that always returned false ("for
--      now, only platform admins are recognised" — but it didn't check
--      is_admin()). With the function returning false, every read is empty
--      AND every write is RLS-denied.
--   2. sites / pages / sites_secrets / sites_external_domains had no
--      INSERT / UPDATE / DELETE policies, so even with a fixed admin
--      check, writes from the user session would still 403.
--
-- Both fixes are scoped to "platform admin can do anything"; per-site
-- editor RBAC graduates from this baseline once the editor-grant flow is
-- wired (sites_editor_permissions UI is a later tab).
-- ============================================================================

-- ==========================================================================
-- 1. Fix can_admin_site() — delegate to public.is_admin() until per-site
--    role grants land.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.can_admin_site(p_site_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid = auth.uid();
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;
  -- Platform admin (admin_profiles row + is_active) → site admin everywhere.
  -- Per-site fine-grained admin (e.g. an account-scoped owner) is a
  -- follow-up; that check would OR with this one.
  RETURN public.is_admin();
END;
$$;

COMMENT ON FUNCTION public.can_admin_site(uuid) IS
  'Site admin permission helper. Currently delegates to is_admin(); replace with per-site role check when sites_editor_permissions UI ships.';

-- ==========================================================================
-- 2. Write policies on sites
-- ==========================================================================

CREATE POLICY "sites_admin_insert"
  ON public.sites FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "sites_admin_update"
  ON public.sites FOR UPDATE
  TO authenticated
  USING (public.can_admin_site(id))
  WITH CHECK (public.can_admin_site(id));

CREATE POLICY "sites_admin_delete"
  ON public.sites FOR DELETE
  TO authenticated
  USING (public.can_admin_site(id));

-- ==========================================================================
-- 3. Write policies on the per-site collections
-- ==========================================================================

CREATE POLICY "sites_media_admin_write"
  ON public.sites_media FOR ALL
  TO authenticated
  USING (public.can_admin_site(site_id))
  WITH CHECK (public.can_admin_site(site_id));

CREATE POLICY "sites_secrets_admin_write"
  ON public.sites_secrets FOR ALL
  TO authenticated
  USING (public.can_admin_site(site_id))
  WITH CHECK (public.can_admin_site(site_id));

CREATE POLICY "sites_editor_permissions_admin_write"
  ON public.sites_editor_permissions FOR ALL
  TO authenticated
  USING (public.can_admin_site(site_id))
  WITH CHECK (public.can_admin_site(site_id));

CREATE POLICY "sites_external_domains_admin_write"
  ON public.sites_external_domains FOR ALL
  TO authenticated
  USING (public.can_admin_site(site_id))
  WITH CHECK (public.can_admin_site(site_id));

CREATE POLICY "sites_publisher_deployments_admin_write"
  ON public.sites_publisher_deployments FOR ALL
  TO authenticated
  USING (public.can_admin_site(site_id))
  WITH CHECK (public.can_admin_site(site_id));

-- ==========================================================================
-- 4. Pages writes — admin or editor (READ already exists in 005)
-- ==========================================================================
-- pages writes only allowed for the page's host (site/event/calendar).
-- For host_kind='site', delegate to can_edit_site_content (which already
-- ORs in can_admin_site).

CREATE POLICY "pages_site_admin_write"
  ON public.pages FOR ALL
  TO authenticated
  USING (
    host_kind = 'site' AND host_id IS NOT NULL
    AND public.can_edit_site_content(host_id)
  )
  WITH CHECK (
    host_kind = 'site' AND host_id IS NOT NULL
    AND public.can_edit_site_content(host_id)
  );

CREATE POLICY "page_blocks_site_admin_write"
  ON public.page_blocks FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pages p
      WHERE p.id = page_blocks.page_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.pages p
      WHERE p.id = page_blocks.page_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  );

CREATE POLICY "page_block_bricks_site_admin_write"
  ON public.page_block_bricks FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.page_blocks pb
        JOIN public.pages p ON p.id = pb.page_id
      WHERE pb.id = page_block_bricks.page_block_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.page_blocks pb
        JOIN public.pages p ON p.id = pb.page_id
      WHERE pb.id = page_block_bricks.page_block_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  );

CREATE POLICY "pages_preview_tokens_site_admin_write"
  ON public.pages_preview_tokens FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pages p
      WHERE p.id = pages_preview_tokens.page_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.pages p
      WHERE p.id = pages_preview_tokens.page_id
        AND p.host_kind = 'site'
        AND p.host_id IS NOT NULL
        AND public.can_edit_site_content(p.host_id)
    )
  );
