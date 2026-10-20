-- ============================================================================
-- blog — make sure blog_posts.status allows the triage states
-- ============================================================================
-- 001 creates blog_posts with status in (draft, published, archived,
-- pending_review, rejected), but CREATE TABLE IF NOT EXISTS is a no-op on a
-- database whose table predates that list. AAIF prod, and LF dev copied from
-- it, still carry the original three-state check, so the triage adapter (004)
-- and the content-sources feed scraper, which land posts as pending_review,
-- fail with blog_posts_status_check. Replace the check only when it is
-- missing a state; idempotent.
-- ============================================================================
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.blog_posts'::regclass AND c.conname = 'blog_posts_status_check';
  IF v_def IS NULL OR v_def NOT LIKE '%pending_review%' OR v_def NOT LIKE '%rejected%' THEN
    ALTER TABLE public.blog_posts DROP CONSTRAINT IF EXISTS blog_posts_status_check;
    ALTER TABLE public.blog_posts ADD CONSTRAINT blog_posts_status_check
      CHECK (status IN ('draft', 'published', 'archived', 'pending_review', 'rejected'));
  END IF;
END
$$;
