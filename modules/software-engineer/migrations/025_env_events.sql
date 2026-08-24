-- Test-environment observability (spec-se-multi-test-envs, phase 2/3 + the
-- zero-LFX-code observability layer): the host-side agents and tailers on the
-- staging box append lifecycle/visit/login/service-error events as JSON lines
-- to /staging-control/events.jsonl. The SE module ingests new lines whenever
-- the admin polls GET /test-env/envs (lib/env-events.ts) and serves them back
-- for the Overview "Environments" activity timeline + errors view.
--
-- kind is deliberately NOT check-constrained: a newer host agent may emit a
-- new event kind before the module updates, and ingestion must not start
-- failing when it does. The ingester enforces shape (^[a-z][a-z0-9_]{0,31}$)
-- and length caps instead.
create table public.se_env_events (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null,               -- event time, from the emitting agent
  kind         text not null,                      -- create|ready|fail|reap|teardown|admission_refused|visit|login_success|login_failure|service_error|…
  profile      text not null default 'lfx',
  env_label    text,                               -- null for events with no env (e.g. shared-Authelia logins)
  detail       text,
  meta         jsonb,
  ingested_at  timestamptz not null default now()
);

create index se_env_events_ts_idx on public.se_env_events(ts desc);
create index se_env_events_env_ts_idx on public.se_env_events(env_label, ts desc);
create index se_env_events_kind_ts_idx on public.se_env_events(kind, ts desc);

-- Single-row ingest cursor: byte offset into events.jsonl. The ingester
-- resets to 0 when the file shrinks (rotation/truncation).
create table public.se_env_events_cursor (
  id           int primary key default 1 check (id = 1),
  byte_offset  bigint not null default 0,
  updated_at   timestamptz not null default now()
);

-- Admin-read-only; writes happen exclusively through the service-role client
-- (no authenticated write policy on purpose — events describe host state).
alter table public.se_env_events enable row level security;
drop policy if exists se_env_events_read on public.se_env_events;
create policy se_env_events_read on public.se_env_events for select to authenticated using (public.is_admin());

alter table public.se_env_events_cursor enable row level security;
drop policy if exists se_env_events_cursor_read on public.se_env_events_cursor;
create policy se_env_events_cursor_read on public.se_env_events_cursor for select to authenticated using (public.is_admin());
