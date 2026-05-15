-- ============================================================================
-- 030_separate_publish_repo — graduate newsletters into separate theme +
--                              publish repos (same pattern sites already use)
-- ============================================================================
--
-- Sites support a graduated layout where the theme source repo and the
-- built-output (publish) repo are SEPARATE GitHub/GitLab repos. The
-- platform mirrors the internal `publish` branch onto the publish repo's
-- default branch (`main`) via `sites.config.publish.external_branch =
-- 'main'`, and overlays the theme into the published tree by cloning
-- `sites.config.theme.url` at `sites.config.theme.ref`.
--
-- Newsletters historically used the legacy single-repo model: one external
-- repo with two branches (`main` = theme source, `publish` = built
-- output). Migration 027 added `git_url` / `git_branch` columns on
-- newsletters_template_collections to mirror that layout.
--
-- This migration adds the affordances needed for newsletters to graduate
-- into the same TWO-repo separate layout as sites:
--
--   1. A `config` JSONB column on `newsletters_template_collections` to
--      hold the same shape sites use:
--
--        config.theme.url           text — theme repo HTTPS URL
--        config.theme.ref           text — pinned tag / branch / SHA
--        config.theme.subdir        text — optional subdir within theme repo
--        config.theme.owns_routing  bool — theme controls routing
--                                          (informational; newsletters
--                                          have no `app/*` emission today,
--                                          but the key is honoured so
--                                          themes can declare it without
--                                          a schema change)
--        config.publish.external_branch    text — remote branch name on
--                                                  the PUBLISH repo
--                                                  (default 'publish' for
--                                                  legacy single-repo;
--                                                  'main' for separate-
--                                                  repo convention)
--        config.publish.embed_media_in_git bool — embed binaries in git
--                                                  (mirror of the sites
--                                                  flag; off by default)
--
--   2. A `git_url_theme` column to hold the SEPARATE theme repo URL
--      (when the theme is its own external repo, NOT the same repo
--      backing `git_url`). Null while the legacy single-repo model is in
--      use OR while the theme is configured purely via `config.theme.url`
--      pointing at a third-party repo with no deploy key on the platform
--      side.
--
-- Backwards compatibility:
--   * Existing collections keep `config = '{}'::jsonb` (legacy single-repo
--     behaviour: the publish-worker treats absent `config.publish.external_
--     branch` as 'publish' and absent `config.theme.url` as "no theme
--     overlay").
--   * Existing collections keep `git_url_theme = NULL` (legacy single-repo
--     behaviour: graduate flow without the separate-repo affordance does
--     not write to this column).
--
-- Reversible: the down migration drops both columns.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.newsletters_template_collections.config IS
  'Free-form per-newsletter config (mirror of sites.config). Recognised keys: theme.{url,ref,subdir,owns_routing}, publish.{external_branch,embed_media_in_git}. Per newsletters migration 030.';

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS git_url_theme text;

COMMENT ON COLUMN public.newsletters_template_collections.git_url_theme IS
  'External theme repo URL when the newsletter is graduated into a SEPARATE theme + publish repo layout. Null for legacy single-repo graduations (where git_url holds the one repo and config.theme.url is unset or points at an unrelated theme repo).';

-- ============================================================================
-- Down (for reference; not auto-run). Manual rollback:
--   ALTER TABLE public.newsletters_template_collections
--     DROP COLUMN IF EXISTS git_url_theme,
--     DROP COLUMN IF EXISTS config;
-- ============================================================================
