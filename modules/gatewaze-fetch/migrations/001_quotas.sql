-- gatewaze-fetch — quotas and drift alerts (spec §11.1).
--
-- Quota row lifecycle: rows are created lazily on first fetch attempt
-- by the pre-debit transaction (§9.3 step 5). The transaction does an
-- UPSERT-style `INSERT … ON CONFLICT DO UPDATE` using the calling key's
-- module-default limits and the current calendar-month period. We
-- avoid a schema-level trigger on `public.api_keys` because the
-- platform module contract does not allow modules to install triggers
-- on platform tables.

create schema if not exists gw_fetch;

create table if not exists gw_fetch.quotas (
  -- ON DELETE RESTRICT (default) matches the soft-delete-only policy
  -- for keys with usage history (§11.3). Hard-delete of a key with
  -- ledger rows is rejected by the platform admin API.
  api_key_id uuid primary key references public.api_keys(id),
  period_start timestamptz not null,
  period_end   timestamptz not null,
  requests_limit         integer       not null,
  requests_used          integer       not null default 0,
  browser_seconds_limit  numeric(12,2) not null,
  browser_seconds_used   numeric(12,2) not null default 0,
  proxy_bytes_limit      bigint        not null,
  proxy_bytes_used       bigint        not null default 0,
  updated_at timestamptz not null default now()
);

-- Plain index on period_end. Postgres rejects non-immutable expressions
-- (now()) in partial-index predicates; even where allowed the predicate's
-- truthiness drifts with wall clock. Filter "active period" in the query.
create index if not exists idx_fetch_quotas_period_end
  on gw_fetch.quotas (period_end);

create table if not exists gw_fetch.quota_drift_alerts (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null default now(),
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  dimension text not null check (dimension in ('requests','browser_seconds','proxy_bytes')),
  ledger_value numeric not null,
  counter_value numeric not null,
  drift_pct numeric not null,
  notified boolean not null default false
);

create index if not exists idx_fetch_quota_drift_unnotified
  on gw_fetch.quota_drift_alerts (detected_at desc)
  where notified = false;
