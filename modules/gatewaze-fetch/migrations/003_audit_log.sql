-- gatewaze-fetch — audit log (spec §11.3).
--
-- Audit `status` field encoding:
--   -1   : request started, not finalized (process crash; recovered by §9.6.1)
--   403  : blocked at any stage (blocked_stage + blocked_by disambiguate)
--   415  : content-type rejected
--   429  : quota exhausted (blocked_stage='quota')
--   >=100: upstream HTTP status returned by the target
-- The `0` value previously used for "blocked pre-fetch" is removed —
-- 403 + blocked_stage is the canonical encoding now.

create table if not exists gw_fetch.audit_log (
  request_id text primary key,                    -- ULID; matches X-Request-Id
  -- ON DELETE SET NULL: defensive measure for the rare case a superuser
  -- bypasses the admin API and forces a hard-delete via direct SQL.
  api_key_id uuid references public.api_keys(id) on delete set null,
  -- ULID; nullable for blocked-pre-debit rows (domain/robots/quota
  -- blocks). FK to gw_fetch.usage_ledger(id) is added in migration 005
  -- (forward dep — 005 runs after 003).
  debit_id text,
  fetched_at timestamptz not null default now(),
  surface text not null check (surface in ('rest','mcp_stdio','mcp_http')),
  requested_url text not null,
  url_host text not null,                         -- normalized requested host
  final_url text,
  final_url_host text,                            -- normalized final host (post-redirect)
  redirect_chain jsonb,                           -- max 10 hops; null when no redirect
  mode text not null check (mode in ('fast','stealth','browser')),
  status integer not null,
  blocked_stage text check (blocked_stage in ('pre_fetch','robots','quota','post_fetch')),
  bytes_in bigint not null default 0,
  bytes_out bigint not null default 0,
  proxy_bytes bigint not null default 0,          -- bytes that hit the residential proxy
  browser_seconds numeric(8,2) not null default 0,
  blocked_by text check (blocked_by in (
    'instance_denylist',
    'instance_allowlist_violation',
    'key_denylist',
    'key_allowlist_violation',
    'final_url_domain_blocked',
    'robots',
    'quota'
  )),
  duration_ms integer,
  ignored_robots boolean not null default false,
  user_agent_used text,
  proxy_provider text,
  cost_usd_estimate numeric(10,6) not null default 0,
  truncated_request jsonb,                        -- redacted body per spec
  -- 'circuit_open' is reserved in this enum but is NOT WRITTEN in v1:
  -- circuit-breaker rejections produce no audit row per §10.3
  -- (structured log only). Held for a v2 "outage audit sink" feature
  -- (§16) that may persist outage attempts asynchronously.
  error_class text check (error_class in (
    'upstream_timeout',
    'upstream_connection_error',
    'upstream_pool_full',
    'upstream_proxy_auth',
    'upstream_5xx_other',
    'unsupported_media_type',
    'extraction_timeout',
    'decode_invalid_bytes',
    'circuit_open',
    'internal_error'
  ))
);

create index if not exists idx_fetch_audit_key_time
  on gw_fetch.audit_log (api_key_id, fetched_at desc);
create index if not exists idx_fetch_audit_host
  on gw_fetch.audit_log (url_host, fetched_at desc);
create index if not exists idx_fetch_audit_robots_bypass
  on gw_fetch.audit_log (api_key_id, fetched_at desc)
  where ignored_robots = true;
create index if not exists idx_fetch_audit_blocked
  on gw_fetch.audit_log (api_key_id, fetched_at desc)
  where blocked_by is not null;

-- Retention contract (§11.3 retention sub-section).
-- Default 90 days; pruned by either the platform `data-retention` job
-- or this local fallback function called by pg_cron / systemd timer.
create or replace function gw_fetch.prune_audit_log(
  retention_days int,
  batch_size int default 5000
) returns int
language plpgsql as $$
declare
  total_deleted int := 0;
  rows_this_batch int;
begin
  loop
    with victims as (
      select request_id from gw_fetch.audit_log
       where fetched_at < now() - make_interval(days => retention_days)
       order by fetched_at
       limit batch_size
       for update skip locked
    )
    delete from gw_fetch.audit_log a
     using victims v
     where a.request_id = v.request_id;
    get diagnostics rows_this_batch = row_count;
    total_deleted := total_deleted + rows_this_batch;
    exit when rows_this_batch < batch_size;
    perform pg_sleep(0.1);  -- breathe between batches
  end loop;
  return total_deleted;
end $$;
