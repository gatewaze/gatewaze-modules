-- ============================================================================
-- Module: content-sources
-- Migration: 001_discovery_sources
-- Description: the registry of feeds and scrape targets the FeedScraper
--              sweeps, plus the URL normaliser the unique keys are built on.
--              spec-content-sources-and-research-blocks.md §4.1.
--
-- Executed end to end (with the module's other DDL and 18 assertions) against
-- the local AAIF database before this file was written; see the spec's
-- sibling .layer4.sql. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. discovery_normalize_url — the key two URLs are compared on.
--    Twin of lib/normalize-url.js; the two must agree (unit test pins cases).
--    LANGUAGE sql + regexp chain: cannot raise on malformed input, so one bad
--    link can never abort a batch. IMMUTABLE so it can back indexes and a
--    generated column; that freezes the tracking-param list into the
--    function — extending it means replacing the function and rebuilding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discovery_normalize_url(p_url text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH s1 AS (SELECT regexp_replace(trim(p_url), '^[a-zA-Z][a-zA-Z0-9+.-]*://', '') AS u),
       s2 AS (SELECT regexp_replace(u, '#.*$', '') AS u FROM s1),
       parts AS (
         SELECT lower(regexp_replace(substring(u from '^([^/?]+)'), '^www\.', '')) AS host,
                coalesce(substring(u from '^[^/?]+([^?]*)'), '') AS path,
                substring(u from '\?(.*)$') AS q
         FROM s2),
       cleaned AS (
         SELECT host,
                CASE WHEN path IN ('', '/') THEN '' ELSE rtrim(path, '/') END AS path,
                (SELECT string_agg(p, '&' ORDER BY p)
                   FROM unnest(string_to_array(coalesce(q, ''), '&')) AS p
                  WHERE p <> '' AND p !~* '^(utm_[^=]*|fbclid|gclid|ref|source)(=|$)') AS q
         FROM parts)
  SELECT CASE WHEN host IS NULL THEN lower(trim(p_url))
              ELSE host || path || CASE WHEN q IS NULL THEN '' ELSE '?' || q END END
  FROM cleaned;
$$;
COMMENT ON FUNCTION public.discovery_normalize_url(text) IS
  'Comparison key for URLs: no scheme, lowercase host without www., no fragment, no trailing slash, tracking params removed, params sorted. Twin of content-sources/lib/normalize-url.js.';

-- ---------------------------------------------------------------------------
-- 2. discovery_sources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discovery_sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('feed','sitemap','html')),
  site_url             text NOT NULL,                 -- what the user gave us
  feed_url             text,                          -- resolved feed; for sitemap: the sitemap URL
  path_prefix          text,                          -- sitemap: only <loc>s under this prefix
  scraper_id           text,                          -- html: a registered per-site extractor id
  foundation           text NOT NULL,                 -- display section; later the brand mapping
  project              text NOT NULL,                 -- feed label
  content_category     text,                          -- platform category for landed posts (default 'ecosystem')
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','paused','dead')),
  egress               text NOT NULL DEFAULT 'direct'
                       CHECK (egress IN ('direct','residential')),
  egress_auto          boolean NOT NULL DEFAULT false, -- set when the scraper flipped it
  egress_locked        boolean NOT NULL DEFAULT false, -- operator choice; the scraper never changes a locked row
  etag                 text,
  last_modified        text,
  last_run_at          timestamptz,
  last_ok_at           timestamptz,
  last_entry_at        timestamptz,                   -- newest published_at seen
  last_error           text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  is_canary            boolean NOT NULL DEFAULT false, -- must yield ≥1 entry per run
  added_by_person_id   uuid REFERENCES public.people(id) ON DELETE SET NULL,
  added_via            text NOT NULL DEFAULT 'admin_ui'
                       CHECK (added_via IN ('admin_ui','api','mcp','slack','import')),
  note                 text,                          -- why added / why deactivated
  deactivated_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- The API enforces https and the sitemap prefix; these hold for rows that
  -- arrive by seed, absorb or a direct admin write too (the admin UI links
  -- straight to these URLs).
  CONSTRAINT discovery_sources_https_site  CHECK (site_url ~ '^https://'),
  CONSTRAINT discovery_sources_https_feed  CHECK (feed_url IS NULL OR feed_url ~ '^https://'),
  CONSTRAINT discovery_sources_sitemap_prefix CHECK (kind <> 'sitemap' OR path_prefix IS NOT NULL)
);
COMMENT ON TABLE public.discovery_sources IS
  'Where the FeedScraper looks: feeds, sitemaps and per-site extractors, with provenance and health. Not content_sources (that records how an item arrived).';

CREATE UNIQUE INDEX IF NOT EXISTS discovery_sources_feed_url_norm
  ON public.discovery_sources (public.discovery_normalize_url(feed_url))
  WHERE feed_url IS NOT NULL;
-- html-kind rows have no feed URL; their identity is the site plus the label.
CREATE UNIQUE INDEX IF NOT EXISTS discovery_sources_site_project_nofeed
  ON public.discovery_sources (public.discovery_normalize_url(site_url), project)
  WHERE feed_url IS NULL;
CREATE INDEX IF NOT EXISTS discovery_sources_status_idx ON public.discovery_sources (status);
CREATE INDEX IF NOT EXISTS discovery_sources_foundation_idx ON public.discovery_sources (foundation);

DROP TRIGGER IF EXISTS discovery_sources_updated_at ON public.discovery_sources;
CREATE TRIGGER discovery_sources_updated_at
  BEFORE UPDATE ON public.discovery_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: admins only. On a portal brand every signed-in member is
-- `authenticated`, and this table carries notes, errors and who added what.
ALTER TABLE public.discovery_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discovery_sources_admin_select ON public.discovery_sources;
CREATE POLICY discovery_sources_admin_select ON public.discovery_sources
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS discovery_sources_admin_write ON public.discovery_sources;
CREATE POLICY discovery_sources_admin_write ON public.discovery_sources
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_sources TO authenticated;
GRANT ALL ON public.discovery_sources TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Absorb the private content-pipeline module's registry, if present.
--    `content_discovery_sources` was the same plan; nothing ever ran it.
--    rss → feed, everything else → html (an admin attaches a feed later);
--    is_active → active / paused. Idempotent on the normalised feed URL.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.content_discovery_sources') IS NULL THEN
    RAISE NOTICE 'content-sources: no content_discovery_sources table to absorb';
    RETURN;
  END IF;
  INSERT INTO public.discovery_sources
    (kind, site_url, feed_url, foundation, project, status, added_via, note, created_at)
  SELECT CASE WHEN s.source_type = 'rss' THEN 'feed' ELSE 'html' END,
         s.source_url,
         CASE WHEN s.source_type = 'rss' THEN s.source_url END,
         'Unassigned',
         s.name,
         CASE WHEN s.is_active THEN 'active' ELSE 'paused' END,
         'import',
         'copied from content_discovery_sources ' || s.id::text || ' (content-pipeline)',
         s.created_at
  FROM public.content_discovery_sources s
  WHERE s.source_url ~ '^https://'
    AND NOT EXISTS (
    SELECT 1 FROM public.discovery_sources d
    WHERE d.feed_url IS NOT NULL AND s.source_type = 'rss'
      AND public.discovery_normalize_url(d.feed_url) = public.discovery_normalize_url(s.source_url)
  );
END $$;
