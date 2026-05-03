-- ============================================================================
-- Migration: sites_021_repo_advisory_lock
-- Description: Per-repo advisory-lock RPCs used by the publish flow
--              (per spec §6.2 + lib/git/internal-git-server-impl.ts).
-- ============================================================================

-- Try to acquire a session-scoped advisory lock keyed on hashtext(repo_path).
-- Returns true on success; false if another session holds it.
CREATE OR REPLACE FUNCTION public.try_acquire_repo_lock(p_repo_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN pg_try_advisory_lock(hashtext(p_repo_path));
END $$;

COMMENT ON FUNCTION public.try_acquire_repo_lock(text) IS
  'Per spec §6.2: serializes per-repo publish flow. Returns false if held; caller surfaces 409 publish_in_progress.';

-- Release the session-scoped advisory lock.
CREATE OR REPLACE FUNCTION public.release_repo_lock(p_repo_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN pg_advisory_unlock(hashtext(p_repo_path));
END $$;

-- ============================================================================
-- Helper used by the snapshot job (spec §15.4): find editions whose snapshot
-- delay has elapsed and which haven't been snapshotted yet.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletters_find_due_snapshots()
RETURNS TABLE (
  id uuid,
  list_id uuid,
  list_slug text,
  list_snapshot_delay_days integer,
  subject text,
  sender text,
  sent_at timestamptz,
  template_sha text,
  send_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Note: assumes newsletters_editions has list_id, subject, sender, sent_at,
  -- template_sha, send_count. Adjust column names if schema differs.
  RETURN QUERY
  SELECT
    e.id,
    e.list_id,
    l.slug AS list_slug,
    l.snapshot_delay_days AS list_snapshot_delay_days,
    e.title AS subject,
    COALESCE(e.metadata->>'sender', '') AS sender,
    e.sent_at,
    COALESCE(e.metadata->>'template_sha', '') AS template_sha,
    COALESCE((e.metadata->>'send_count')::integer, 0) AS send_count
  FROM public.newsletters_editions e
  LEFT JOIN public.lists l ON l.id = e.list_id
  WHERE e.snapshot_status = 'pending'
    AND e.sent_at IS NOT NULL
    AND e.sent_at < (now() - (COALESCE(l.snapshot_delay_days, 6) * interval '1 day'));
END $$;

COMMENT ON FUNCTION public.newsletters_find_due_snapshots() IS
  'Per spec §15.4: snapshot job query. Returns editions whose snapshot_delay_days has elapsed.';
