-- ============================================================================
-- Migration: sites_039_repo_lock_table
-- Description: Replace the per-repo *session* advisory lock with a
--              connection-independent, TTL-expiring table lease.
--
-- Why: the publish flow acquires the lock in one PostgREST RPC call
-- (try_acquire_repo_lock), does git work in Node, then releases in a
-- SEPARATE RPC call (release_repo_lock). PostgREST pools connections, so
-- pg_advisory_lock() — which is *session*-scoped — was taken on one pooled
-- backend while the release frequently ran on a different backend. The
-- unlock then no-ops and the lock stays held forever on the original
-- connection, so every later publish fails with
--   "publish_in_progress: another publish for this repo is in flight".
-- Even a fully successful publish leaks the lock this way.
--
-- A table lease fixes both failure modes: it is visible/mutable from any
-- pooled connection, and a crashed publish self-heals once the TTL elapses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.git_repo_locks (
  repo_path  text PRIMARY KEY,
  locked_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.git_repo_locks IS
  'Per-repo publish lease (a row = lock held). Acquired/expired by try_acquire_repo_lock, cleared by release_repo_lock. Replaces the pre-039 pg_advisory_lock, which leaked across PostgREST''s pooled connections.';

-- Only the SECURITY DEFINER RPCs below should touch this table; keep it off
-- the REST surface for the anon/authenticated roles.
REVOKE ALL ON public.git_repo_locks FROM PUBLIC;

-- try_acquire gains a TTL argument, which changes the signature — drop the
-- old single-arg session-lock version first so we don't leave an overload.
DROP FUNCTION IF EXISTS public.try_acquire_repo_lock(text);

CREATE FUNCTION public.try_acquire_repo_lock(
  p_repo_path   text,
  p_ttl_seconds integer DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_got boolean;
BEGIN
  -- Atomic acquire-or-steal-if-expired in a single statement, so two
  -- concurrent callers can't both win: the loser's ON CONFLICT sees a fresh
  -- row, the WHERE blocks the UPDATE, and no RETURNING row comes back.
  INSERT INTO public.git_repo_locks AS l (repo_path, locked_at)
  VALUES (p_repo_path, now())
  ON CONFLICT (repo_path) DO UPDATE
    SET locked_at = now()
    WHERE l.locked_at < now() - make_interval(secs => p_ttl_seconds)
  RETURNING true INTO v_got;

  RETURN COALESCE(v_got, false);
END $$;

COMMENT ON FUNCTION public.try_acquire_repo_lock(text, integer) IS
  'Per spec §6.2: serializes per-repo publish via a table lease. TTL-expiring (default 900s). Returns false while a non-expired lock is held.';

CREATE OR REPLACE FUNCTION public.release_repo_lock(p_repo_path text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.git_repo_locks WHERE repo_path = p_repo_path;
  RETURN true;
END $$;

COMMENT ON FUNCTION public.release_repo_lock(text) IS
  'Releases the per-repo publish lease by deleting the lock row. Safe to call from any pooled connection (unlike the pre-039 pg_advisory_unlock).';
