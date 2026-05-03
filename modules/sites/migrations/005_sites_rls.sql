-- ============================================================================
-- Migration: sites_005_rls
-- Description: RLS for sites_*, pages, page_blocks, page_block_bricks,
--              media_refs, sites_external_domains, sites_publisher_deployments.
--              Per spec-sites-module.md §4.4.
--
--              All write operations go through the API server with
--              service_role (which bypasses RLS by default). Anon SELECT
--              is permitted only for published pages whose host's
--              published-content rules allow.
-- ============================================================================

ALTER TABLE public.sites                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_secrets                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_editor_permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_media                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_external_domains        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_publisher_deployments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_blocks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_block_bricks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_refs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages_preview_tokens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages_host_registrations      ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- Permission helper functions
-- ==========================================================================

-- can_admin_site(:site_id) — site admin OR platform admin.
-- The platform-admin check delegates to a helper exposed by the auth /
-- platform layer (`is_platform_admin()`). For modules that don't have that
-- helper installed yet, the function falls back to checking auth.uid()
-- against a hardcoded super-admins table — but in this v0.1 we just trust
-- the platform helper.
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

  -- Platform admin? Delegate to the platform helper if available.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = 'public' AND p.proname = 'is_platform_admin'
  ) THEN
    IF (SELECT public.is_platform_admin()) THEN
      RETURN true;
    END IF;
  END IF;

  -- A Site Editor with can_publish=true is NOT a site admin — admin and
  -- editor are distinct (per spec §6.4). The site admin role is granted
  -- by the platform's role assignment (e.g. `gatewaze_admin` on the
  -- people row). For now, only platform admins are recognised.
  RETURN false;
END;
$$;

-- can_edit_site_content(:site_id) — Site Editor OR Site Admin.
CREATE OR REPLACE FUNCTION public.can_edit_site_content(p_site_id uuid)
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

  IF public.can_admin_site(p_site_id) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.sites_editor_permissions
     WHERE site_id = p_site_id AND user_id = v_uid
  );
END;
$$;

-- can_publish_site_page(:site_id) — Site Editor with can_publish=true OR admin.
CREATE OR REPLACE FUNCTION public.can_publish_site_page(p_site_id uuid)
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

  IF public.can_admin_site(p_site_id) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.sites_editor_permissions
     WHERE site_id = p_site_id AND user_id = v_uid AND can_publish = true
  );
END;
$$;

-- ==========================================================================
-- pages_host_registrations: read-only for everyone authenticated; writes
-- via service_role only.
-- ==========================================================================

CREATE POLICY "pages_host_registrations_authenticated_read"
  ON public.pages_host_registrations FOR SELECT
  TO authenticated
  USING (true);

-- ==========================================================================
-- pages — read via host registry dispatch
-- ==========================================================================

-- Helper that resolves can_*_fn from the host registry and calls it.
CREATE OR REPLACE FUNCTION public.can_view_page(p_host_kind text, p_host_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_can_fn text;
  v_result boolean;
BEGIN
  SELECT can_edit_pages_fn INTO v_can_fn
    FROM public.pages_host_registrations
   WHERE host_kind = p_host_kind AND enabled = true;

  IF v_can_fn IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE format('SELECT %I($1)', v_can_fn) INTO v_result USING p_host_id;
  RETURN COALESCE(v_result, false);
END;
$$;

-- Helper: is this published-page row visible to the host's anon-public rules?
-- Currently the only host with public anon access is `site` and `portal`;
-- events, calendars, blogs apply their own rules in their own RLS policies
-- (those modules' published-content predicates govern when their pages can
-- be read by anon). For sites, anon-published is allowed when the site is
-- active.
CREATE OR REPLACE FUNCTION public.published_page_anon_visible(p_host_kind text, p_host_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_host_kind = 'portal' THEN
    RETURN true;     -- loose portal pages are public-by-default when published
  END IF;
  IF p_host_kind = 'site' THEN
    RETURN EXISTS (SELECT 1 FROM public.sites WHERE id = p_host_id AND status = 'active');
  END IF;
  -- Other hosts (calendar, event, blog_post, …) own their visibility rules
  -- in their own modules. Default to false; the host module installs its
  -- own policy on the pages table when it opts in.
  RETURN false;
END;
$$;

CREATE POLICY "pages_anon_published"
  ON public.pages FOR SELECT
  TO anon
  USING (status = 'published' AND public.published_page_anon_visible(host_kind, host_id));

CREATE POLICY "pages_authenticated_admin_or_anon_published"
  ON public.pages FOR SELECT
  TO authenticated
  USING (
    public.can_view_page(host_kind, host_id)
    OR (status = 'published' AND public.published_page_anon_visible(host_kind, host_id))
  );

-- ==========================================================================
-- page_blocks / page_block_bricks: cascade through page access
-- ==========================================================================

CREATE POLICY "page_blocks_via_page"
  ON public.page_blocks FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pages p WHERE p.id = page_blocks.page_id
       AND (
         public.can_view_page(p.host_kind, p.host_id)
         OR (p.status = 'published' AND public.published_page_anon_visible(p.host_kind, p.host_id))
       )
  ));

CREATE POLICY "page_blocks_anon_published"
  ON public.page_blocks FOR SELECT
  TO anon
  USING (EXISTS (
    SELECT 1 FROM public.pages p WHERE p.id = page_blocks.page_id
       AND p.status = 'published'
       AND public.published_page_anon_visible(p.host_kind, p.host_id)
  ));

CREATE POLICY "page_block_bricks_via_block"
  ON public.page_block_bricks FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.page_blocks pb
                 JOIN public.pages p ON p.id = pb.page_id
       WHERE pb.id = page_block_bricks.page_block_id
         AND (
           public.can_view_page(p.host_kind, p.host_id)
           OR (p.status = 'published' AND public.published_page_anon_visible(p.host_kind, p.host_id))
         )
  ));

CREATE POLICY "page_block_bricks_anon_published"
  ON public.page_block_bricks FOR SELECT
  TO anon
  USING (EXISTS (
    SELECT 1 FROM public.page_blocks pb
                 JOIN public.pages p ON p.id = pb.page_id
       WHERE pb.id = page_block_bricks.page_block_id
         AND p.status = 'published'
         AND public.published_page_anon_visible(p.host_kind, p.host_id)
  ));

-- ==========================================================================
-- sites: site admin or editor reads
-- ==========================================================================

CREATE POLICY "sites_admin_or_editor_read"
  ON public.sites FOR SELECT
  TO authenticated
  USING (public.can_admin_site(id) OR public.can_edit_site_content(id));

-- sites_media / sites_editor_permissions / sites_external_domains /
-- sites_publisher_deployments: site admin or editor
CREATE POLICY "sites_media_admin_or_editor_read"
  ON public.sites_media FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id) OR public.can_edit_site_content(site_id));

CREATE POLICY "sites_editor_permissions_admin_read"
  ON public.sites_editor_permissions FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id));

CREATE POLICY "sites_external_domains_admin_or_editor_read"
  ON public.sites_external_domains FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id) OR public.can_edit_site_content(site_id));

CREATE POLICY "sites_publisher_deployments_admin_read"
  ON public.sites_publisher_deployments FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id));

-- sites_secrets: site admin only, and the encrypted_value column is excluded
-- from any client-readable response. RLS doesn't filter columns; the API
-- handler must project only `key, created_at, updated_at` on read.
CREATE POLICY "sites_secrets_admin_read"
  ON public.sites_secrets FOR SELECT
  TO authenticated
  USING (public.can_admin_site(site_id));

-- media_refs: read-only by site admins (used to display media in-use info).
CREATE POLICY "media_refs_admin_read"
  ON public.media_refs FOR SELECT
  TO authenticated
  USING (
    -- The reverse-link to a site is via the source row; we walk through
    -- the source_kind. For page_block / page_block_brick refs, find the
    -- containing page → site.
    EXISTS (
      SELECT 1
        FROM public.page_blocks pb
        JOIN public.pages p ON p.id = pb.page_id
        WHERE source_kind = 'page_block'
          AND source_id = pb.id
          AND p.host_kind = 'site'
          AND public.can_admin_site(p.host_id)
    )
    OR EXISTS (
      SELECT 1
        FROM public.page_block_bricks br
        JOIN public.page_blocks pb ON pb.id = br.page_block_id
        JOIN public.pages p ON p.id = pb.page_id
        WHERE source_kind = 'page_block_brick'
          AND source_id = br.id
          AND p.host_kind = 'site'
          AND public.can_admin_site(p.host_id)
    )
    OR (source_kind = 'site_seo'  AND public.can_admin_site(source_id))
    OR (source_kind = 'page_seo'  AND EXISTS (
      SELECT 1 FROM public.pages p
       WHERE p.id = source_id AND p.host_kind = 'site' AND public.can_admin_site(p.host_id)
    ))
  );

-- pages_preview_tokens: only the API ever reads these (via service_role).
-- No SELECT policy — RLS denies authenticated reads. That's intentional.
