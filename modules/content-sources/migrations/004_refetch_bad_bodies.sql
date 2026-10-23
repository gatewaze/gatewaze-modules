-- ============================================================================
-- Module: content-sources
-- Migration: 004_refetch_bad_bodies
-- Description: put discovered posts whose stored body is known to be wrong
--              back on the body backlog, now that the extractor finds the
--              real post container and the cap is 200 KB.
--
-- Three gaps measured on LF dev:
--   - The 60 KB cap cut long posts mid-tag (every blog.cloudflare.com post,
--     some nodejs.org, ceph.io and AWS posts). Those bodies are exactly at
--     the cap.
--   - HubSpot sites (www.linuxfoundation.org, finos.org) keep the post in
--     #hs_cos_wrapper_post_body, which the extractor did not know: it stored
--     a related-post <article> card or the whole <main> with the page chrome,
--     or nothing at all.
--   - developers.googleblog.com matched no container, so the body stayed
--     NULL and the backlog gave up after three attempts.
--
-- For all three hosts every stored body came from the wrong region, so all
-- of their pending posts are reset, not only the short ones.
--
-- Scope: only rows the FeedScraper owns (discovery_source_id IS NOT NULL) and
-- that are still pending_review. Nothing a human approved, rejected or
-- edited after publishing is touched. Resetting content to NULL and
-- body_fetch_attempts to 0 is what puts a row back on the backlog
-- (idx_blog_posts_body_backlog). Idempotent: a second run only re-queues
-- the same rows for another fetch.
--
-- Also makes sure featured_image exists. The blog module creates it in 001,
-- but databases baselined from an older table can lack columns 001 folded
-- in later (see blog/011), and the FeedScraper now writes it.
-- ============================================================================

-- Guarded rather than a bare ADD COLUMN IF NOT EXISTS: that still needs
-- table ownership even when the column is already there.
DO $col$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'blog_posts' AND column_name = 'featured_image'
  ) THEN
    ALTER TABLE public.blog_posts ADD COLUMN featured_image text;
  END IF;
END
$col$;

UPDATE public.blog_posts
   SET content = NULL,
       body_fetch_attempts = 0
 WHERE discovery_source_id IS NOT NULL
   AND status = 'pending_review'
   AND (
         length(content) >= 59990
      OR lower(substring(canonical_url FROM '^https?://([^/:?#]+)')) IN (
           'www.linuxfoundation.org', 'linuxfoundation.org',
           'www.finos.org', 'finos.org',
           'developers.googleblog.com'
         )
       );
