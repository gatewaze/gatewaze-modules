-- ============================================================================
-- Module: lists
-- Migration: 004_lists_git_provenance
-- Description: git_provenance, git_url, wrapper_id, snapshot_delay_days,
--              send_schedule_cron, republish_webhook_secret on lists.
--              Per spec-content-modules-git-architecture §6 + §10.4 + §15.
-- ============================================================================

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS git_provenance text NOT NULL DEFAULT 'internal'
  CHECK (git_provenance IN ('internal', 'external'));

COMMENT ON COLUMN public.lists.git_provenance IS
  'internal = bare repo on PVC at /var/gatewaze/git/list/<slug>.git; external = user-provided GitHub/GitLab URL with deploy key.';

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS git_url text;

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS git_lfs_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS wrapper_id uuid REFERENCES public.templates_wrappers(id);

COMMENT ON COLUMN public.lists.wrapper_id IS
  'Per spec §10.4: single email wrapper per list (theme_kind=email, role=site). Editions can override via newsletters_editions.wrapper_id_override.';

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS snapshot_delay_days integer NOT NULL DEFAULT 6
  CHECK (snapshot_delay_days BETWEEN 1 AND 90);

COMMENT ON COLUMN public.lists.snapshot_delay_days IS
  'Per spec §15.4: days post-send before edition stats are frozen and per-recipient HTML purged from DB.';

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS send_schedule_cron text;

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS republish_webhook_secret text;

COMMENT ON COLUMN public.lists.republish_webhook_secret IS
  'HMAC-SHA256 secret for /api/webhooks/republish/list/:listSlug.';
