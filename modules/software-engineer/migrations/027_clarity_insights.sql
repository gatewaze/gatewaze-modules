-- Microsoft Clarity live-insights cache + hard daily call budget.
--
-- Clarity's Data Export API allows a MAXIMUM OF 10 REQUESTS PER PROJECT PER
-- DAY (learn.microsoft.com/en-us/clarity/setup-and-installation/
-- clarity-data-export-api) and only looks back 1-3 days. That makes it a
-- warehouse-it-yourself feed, not something a page can call: every render or
-- poll that reached Clarity directly would exhaust the day's quota in under a
-- minute and blind the whole project until 00:00 UTC.
--
-- So the module never calls Clarity from a request path that a user can
-- repeat. It keeps the newest response here and serves that; a refresh only
-- happens when the cache is older than the refresh interval, and every call —
-- scheduled or operator-forced — decrements the budget row below first.
create table if not exists public.se_clarity_snapshots (
  id           bigint generated always as identity primary key,
  fetched_at   timestamptz not null default now(),
  num_of_days  smallint    not null,
  ok           boolean     not null,
  error        text,                 -- HTTP status / parse failure, no token ever
  payload      jsonb                 -- the parsed metric array, null when !ok
);

create index if not exists se_clarity_snapshots_fetched_idx
  on public.se_clarity_snapshots(fetched_at desc);

-- One row per UTC day; `calls` is incremented by a guarded UPDATE so two
-- concurrent polls cannot both believe they had the last slot. Rows are kept
-- (they are tiny) so the operator can see yesterday's spend.
create table if not exists public.se_clarity_budget (
  day        date primary key,
  calls      integer     not null default 0,
  updated_at timestamptz not null default now()
);

-- Admin-read-only; all writes go through the service-role client. The Clarity
-- API token lives in the API container's environment and never reaches these
-- tables, this schema, or the browser.
alter table public.se_clarity_snapshots enable row level security;
drop policy if exists se_clarity_snapshots_read on public.se_clarity_snapshots;
create policy se_clarity_snapshots_read on public.se_clarity_snapshots
  for select to authenticated using (public.is_admin());

alter table public.se_clarity_budget enable row level security;
drop policy if exists se_clarity_budget_read on public.se_clarity_budget;
create policy se_clarity_budget_read on public.se_clarity_budget
  for select to authenticated using (public.is_admin());
