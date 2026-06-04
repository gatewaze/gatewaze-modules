-- gatewaze-fetch — robots.txt cache (spec §11.5).
--
-- Origin format is enforced application-side via the same canonicalization
-- used for URL hosts (§10.4). We don't add a SQL CHECK constraint —
-- application normalization is the single source of truth and a regex
-- CHECK would either be incomplete (allowing subtle bypasses) or duplicate
-- the application logic.

create table if not exists gw_fetch.robots_cache (
  origin text primary key,                        -- normalized "scheme://host[:port]"
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  status integer not null,                        -- HTTP status of the robots.txt fetch
  body text,                                      -- truncated to 64 KiB
  parse_error text                                -- non-null if parse failed
);

create index if not exists idx_fetch_robots_expires
  on gw_fetch.robots_cache (expires_at);
