-- ============================================================================
-- Module: templates
-- Migration: 028_sources_token_column_privileges
-- Description: templates_sources.token_secret_ref holds the git credential
-- itself (the secrets-store indirection it was named for never landed), and
-- the table-level SELECT grant let any caller the row policy admits read it
-- straight through PostgREST. Row policies cannot hide a column, so the
-- table-level SELECT for the client roles is replaced by a column list that
-- leaves the credential out. The service role (the templates API, the
-- drift monitor) keeps full access. A client `select('*')` on this table
-- would now fail; every reader in the admin names its columns.
-- ============================================================================
REVOKE SELECT ON public.templates_sources FROM authenticated, anon;
GRANT SELECT (
  id, library_id, kind, label, status, url, branch, manifest_path,
  installed_git_sha, available_git_sha, last_checked_at, last_check_error, last_check_duration_ms,
  auto_apply, upload_blob_ref, upload_sha, inline_html, inline_sha,
  created_at, updated_at, created_by, theme_kind
) ON public.templates_sources TO authenticated, anon;
