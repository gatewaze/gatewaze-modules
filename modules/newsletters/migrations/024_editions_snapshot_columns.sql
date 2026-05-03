-- ============================================================================
-- Migration: newsletters_024_editions_snapshot_columns
-- Description: Edition snapshot lifecycle columns + publish-branch tracking.
--              Per spec-content-modules-git-architecture §15.
-- ============================================================================

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS snapshot_status text NOT NULL DEFAULT 'pending'
  CHECK (snapshot_status IN ('pending', 'snapshotted'));

COMMENT ON COLUMN public.newsletters_editions.snapshot_status IS
  'Per spec §15.4: pending = within snapshot_delay_days window; snapshotted = stats frozen, per-recipient HTML purged from DB.';

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS snapshot_at timestamptz;

COMMENT ON COLUMN public.newsletters_editions.snapshot_at IS
  'When the snapshot job ran. NULL until snapshot_status flips to snapshotted.';

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS publish_commit_sha text;

COMMENT ON COLUMN public.newsletters_editions.publish_commit_sha IS
  'Git commit SHA on the publish branch where this edition was written (under editions/<slug>/).';

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS publish_tag text;

COMMENT ON COLUMN public.newsletters_editions.publish_tag IS
  'Git tag e.g. edition/2026-05-03-0900-monthly-news.';

-- ============================================================================
-- Index supporting the snapshot job: find editions due for snapshotting
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_newsletters_editions_snapshot_due
  ON public.newsletters_editions (sent_at)
  WHERE snapshot_status = 'pending' AND sent_at IS NOT NULL;

COMMENT ON INDEX public.idx_newsletters_editions_snapshot_due IS
  'Snapshot job query: WHERE snapshot_status=''pending'' AND sent_at < (now() - lists.snapshot_delay_days * interval ''1 day'').';
