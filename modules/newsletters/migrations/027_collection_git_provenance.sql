-- ============================================================================
-- 027_collection_git_provenance — git fields on newsletter channel containers
-- ============================================================================
--
-- Per spec-builder-evaluation §3.6 (extended). Mirrors sites'
-- git_provenance/git_url pattern (sites migration 013) on the newsletter
-- channel container (`newsletters_template_collections`). Each newsletter
-- channel can be in one of two git modes:
--
--   git_provenance='internal'  — bare repo on the platform's PVC at
--                                 /var/gatewaze/git/newsletter/<slug>.git;
--                                 git_url is null (resolved via gatewaze_
--                                 internal_repos lookup at publish time).
--   git_provenance='external'  — repo lives on GitHub/GitLab; git_url
--                                 holds the clone URL. Platform pushes
--                                 publish branch via deploy key.
--
-- Default 'internal' for backwards-compatibility — existing collections
-- become internal-mode, and the lazy boilerplate clone in publish-to-git
-- creates their bare repo on first publish.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS git_provenance text
    NOT NULL DEFAULT 'internal'
    CHECK (git_provenance IN ('internal', 'external')),
  ADD COLUMN IF NOT EXISTS git_url text,
  ADD COLUMN IF NOT EXISTS git_branch text NOT NULL DEFAULT 'publish';

COMMENT ON COLUMN public.newsletters_template_collections.git_provenance IS
  'internal = platform-managed bare repo on PVC; external = GitHub/GitLab clone URL in git_url. Per spec-builder-evaluation §3.6 (extended).';

COMMENT ON COLUMN public.newsletters_template_collections.git_url IS
  'External clone URL (HTTPS or SSH). Set by the graduate-to-external action. Null while git_provenance=internal.';

COMMENT ON COLUMN public.newsletters_template_collections.git_branch IS
  'Branch to which edition publishes commit. Defaults to ''publish'' to match the sites convention.';
