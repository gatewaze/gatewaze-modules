-- ============================================================================
-- Module: content-sources
-- Migration: 002_blog_posts_discovery_columns
-- Description: what the FeedScraper needs on blog_posts — the external
--              marker (added here IF NOT EXISTS so a public module does not
--              depend on the private blog-scraper module's migration), the
--              source link, body backlog bookkeeping, a nullable body, and
--              the normalised-URL key with its unique index.
--              spec-content-sources-and-research-blocks.md §4.3.
-- ============================================================================

ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discovery_source_id uuid
    REFERENCES public.discovery_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS body_fetch_attempts smallint NOT NULL DEFAULT 0;

-- The body is NULL until fetched (and stays NULL after three failed
-- attempts); '' meant "fetched, nothing usable" and the two must differ for
-- the backlog query. The blog module's readers treat both as empty.
ALTER TABLE public.blog_posts ALTER COLUMN content DROP NOT NULL;

-- A STORED generated column rather than an expression index alone, so the
-- scraper can look a URL up through PostgREST (`eq('canonical_url_norm', …)`)
-- instead of reconstructing the expression client-side.
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS canonical_url_norm text
    GENERATED ALWAYS AS (public.discovery_normalize_url(canonical_url)) STORED;

CREATE INDEX IF NOT EXISTS idx_blog_posts_discovery_source ON public.blog_posts (discovery_source_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_body_backlog
  ON public.blog_posts (published_at DESC)
  WHERE is_external = true AND discovery_source_id IS NOT NULL AND content IS NULL AND body_fetch_attempts < 3;

-- Pre-check before the unique index: fail loudly with the offending keys
-- rather than with an opaque index-creation error.
DO $$
DECLARE v_dups text;
BEGIN
  SELECT string_agg(k || ' (' || n || ')', ', ') INTO v_dups
  FROM (
    SELECT canonical_url_norm AS k, count(*) AS n
    FROM public.blog_posts
    WHERE is_external = true AND canonical_url IS NOT NULL
    GROUP BY canonical_url_norm HAVING count(*) > 1
  ) d;
  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION 'content-sources 002: duplicate external canonical URLs exist, dedupe before the unique index: %', v_dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_canonical_url_external
  ON public.blog_posts (canonical_url_norm)
  WHERE is_external = true AND canonical_url IS NOT NULL;

COMMENT ON COLUMN public.blog_posts.discovery_source_id IS
  'Set when the content-sources FeedScraper owns this row. NULL means another scraper or a human owns it and discovery never touches it.';
COMMENT ON COLUMN public.blog_posts.canonical_url_norm IS
  'discovery_normalize_url(canonical_url); the dedupe key for external posts.';
