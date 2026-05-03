-- ============================================================================
-- Migration: sites_020_boilerplate_versions
-- Description: Cache of latest available boilerplate-repo tags.
--              Per spec-content-modules-git-architecture §14.4 + §18.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.gatewaze_boilerplate_versions (
  boilerplate_id    text PRIMARY KEY,
                       -- e.g. 'gatewaze-template-site', 'gatewaze-template-newsletter'
  latest_tag        text NOT NULL,
  release_notes_md  text,
  fetched_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.gatewaze_boilerplate_versions IS
  'Per spec §14.4: platform polls each boilerplate repo''s GitHub Releases API every 6h (configurable via config.boilerplate.poll_interval_seconds). "Apply theme update" UX reads from here.';

ALTER TABLE public.gatewaze_boilerplate_versions ENABLE ROW LEVEL SECURITY;

-- Read-only to authenticated admins; writes only by service-role poller
CREATE POLICY "boilerplate_versions_read"
  ON public.gatewaze_boilerplate_versions FOR SELECT TO authenticated
  USING (public.is_admin());
