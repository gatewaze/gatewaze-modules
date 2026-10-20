# Content Discovery

Where content comes from. A managed registry of blog feeds and scrape targets, a generic feed scraper that lands new posts in the blog module as pending review, and the surfaces to manage the registry: a Sources tab in the Content hub, the public API, and MCP tools.

It began as a port of the LF Executive Director newsletter blog harvest, a weekly Python sweep of 156 foundation and project feeds. The rules that script learned the hard way are kept: liveness is judged by entry dates and never by a feed-level `updated` stamp, a Hugo root `index.xml` is a site feed not a blog feed, a sitemap's `lastmod` is only a candidate filter because a site-wide regeneration re-stamps every post, syndicated copies are collapsed on URL and then on title plus date, and a run that finds nothing while feeds fail is treated as a dead network rather than a quiet week.

## How It Works

### The registry

`discovery_sources` holds one row per feed, sitemap or site. Each row has a kind (`feed`, `sitemap`, `html`), the site and feed URLs, a foundation and project label, a status (`pending`, `active`, `paused`, `dead`), provenance (who added it, through which surface, and why), health (last run, last success, last error, consecutive failures, newest entry seen), conditional-GET validators, and an egress mode. Feed URLs are unique on a normalised key (`discovery_normalize_url`: no scheme, lowercase host without `www.`, no fragment or trailing slash, tracking params removed, params sorted), so `http://www.example.org/feed/` and `https://example.org/feed` are one source. The same normaliser exists as JavaScript in `lib/normalize-url.js`; the two must agree and a unit test pins the shared cases.

If the private content-pipeline module's `content_discovery_sources` table exists when this module installs, its rows are copied in once. That table was the same plan without a worker.

### Resolving a feed from a site URL

Users give a site, not a feed. `lib/resolve-feed.js` fetches the page and reads its `<link rel="alternate">` feed tags; failing that it probes the twelve common paths in order (`/feed/`, `/feed.xml`, `/rss.xml`, `/index.xml`, and so on). Every candidate must be https on a public host, must parse, and must have at least one dated entry. A candidate on a different registrable domain than the site is returned flagged `cross_domain` and is never activated automatically, so a page cannot register a third party's feed under its own name. A section feed is preferred over a root `index.xml`.

### The scraper

`FeedScraper` runs as one row in the standard Scrapers dashboard ("Discovery feeds", daily at 05:30 UTC), contributed through `scrapers/register.js`. One run sweeps every active source with bounded concurrency (16) and a per-host cap (2), sends `If-None-Match` and `If-Modified-Since`, and treats a 304 as alive. Parsing is dependency-free (RSS 2.0, Atom, RDF) because the worker image bakes module dependencies at build time and a new parser would break every worker until the next release.

Per entry, in order: the URL is normalised; if a `blog_posts` row with the same key exists and belongs to another scraper or a human (`discovery_source_id` is null) it is never touched; if it exists and is ours it is updated in place; if the same title was published within a day under another source the entry is logged as a collapse and skipped; otherwise a new row is inserted with `status` and `publish_state` both `pending_review`, `is_external` true, the source's `content_category` (default `ecosystem`), and a slug of the form `host--path` (a hash replaces empty or numeric paths). Every new row is recorded in `content_sources` so the Content Inbox shows where it came from. Rejected posts are never resurrected.

The guard: a source counts as alive when it answered 2xx or 304. If no source was alive and at least one failed, the job fails with "network dead, not a quiet week" and writes no posts, though per-source health is still recorded.

A second phase fetches the article page for posts with no body yet (`content IS NULL`, fewer than three attempts), extracts and sanitises the body (allow-list, 60 KB cap), takes `og:description` as the excerpt when the feed gave none, and leaves `content` null on failure so the next run retries. Sitemap sources fetch a bounded number of article pages per run to learn real publish dates.

### Egress

Direct fetch by default, through the scrapers module's guarded fetch (private addresses refused at DNS, redirects re-policed, size caps). A source can be set to `residential`, which routes through the residential-egress module's in-process proxy. The scraper flips a source to residential by itself only after two consecutive 403s on a run where fewer than a quarter of sources failed, and never when the operator has locked the row. Flipping a source back to direct in the Sources tab locks it. A 429 is a rate limit and never flips anything.

### Surfaces

- **Sources tab** (Content → Sources → Discovery Sources): list with health and filters; add a source from a site URL; approve, pause, resume, mark dead; flip egress; probe; run now for one source or all.
- **Public API** (`/api/v1/content-sources/*`, scopes `content-sources:read|write|admin`): list, get, submit, patch, resolve. Submissions land `pending` unless the key carries the admin scope. `resolve` and `submit` are rate limited per key.
- **MCP**: `content-sources_list`, `_get`, `_resolve`, `_submit`, `_set_status`, catalogued at `/api/v1/mcp/tools`; the hosted MCP server exposes the callable versions through the public API.

## Configuration

- `default_content_category` (default `ecosystem`): the category given to discovered posts whose source sets none.

Scraper tuning lives on the "Discovery feeds" row's config in the Scrapers dashboard: `concurrency`, `per_host`, `lookback_days` (2 to 60, default 21), `body_fetch_cap`, `sitemap_page_cap`, `run_budget_minutes`, `fetch_full_content`.

## Features

- `content-sources` — read the registry; the Sources tab.
- `content-sources.manage` — add, approve, pause and run.

## Dependencies

- `scrapers` — the dashboard and job runner the FeedScraper is contributed to.
- `blog` — the landing table (`blog_posts`). This module adds `is_external`, `discovery_source_id`, `source_updated_at`, `body_fetch_attempts` and the generated `canonical_url_norm` key, and makes `content` nullable.
- `content-platform` — `record_content_source` and the Content hub's Sources section.
