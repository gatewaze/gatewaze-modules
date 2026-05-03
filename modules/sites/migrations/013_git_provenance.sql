-- ============================================================================
-- Migration: sites_013_git_provenance
-- Description: Add git_provenance, git_url, git_lfs_enabled, wrapper_id +
--              publish/republish config columns to sites.
--              Per spec-content-modules-git-architecture §6 + §10.6.
-- ============================================================================

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS git_provenance text NOT NULL DEFAULT 'internal'
  CHECK (git_provenance IN ('internal', 'external'));

COMMENT ON COLUMN public.sites.git_provenance IS
  'internal = bare repo on PVC at /var/gatewaze/git/site/<slug>.git; external = user-provided GitHub/GitLab URL with deploy key.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS git_url text;

COMMENT ON COLUMN public.sites.git_url IS
  'For external: GitHub/GitLab clone URL. For internal: NULL (resolved via gatewaze_internal_repos.bare_path) or set to public HTTPS endpoint after provisioning.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS git_lfs_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sites.git_lfs_enabled IS
  'Per-site Git LFS opt-in for users who want everything in git regardless of size. Off by default (hybrid storage handles >2MB via CDN). v1.x for internal repos.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS wrapper_id uuid REFERENCES public.templates_wrappers(id);

COMMENT ON COLUMN public.sites.wrapper_id IS
  'Per spec §10.2: site-level layout. Defaults to library''s role=site wrapper named "site" if not set.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS publish_schedule_cron text;

COMMENT ON COLUMN public.sites.publish_schedule_cron IS
  'Cron expression for scheduled republish (per spec §6.7). NULL = no schedule. Standard 5-field cron syntax.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS republish_webhook_secret text;

COMMENT ON COLUMN public.sites.republish_webhook_secret IS
  'HMAC-SHA256 secret for /api/webhooks/republish/:siteSlug. Rotated via "Rotate webhook secret" admin action — invalidates all previously-issued URLs.';
