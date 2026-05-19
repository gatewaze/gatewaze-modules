-- tasks module — 012 — per-board outbound webhook config (spec §3.8 + §10.5).
--
-- url and secret are stored encrypted via pgp_sym_encrypt when the
-- TASKS_WEBHOOK_ENCRYPTION_KEY env var is configured by the API
-- layer at write time. When unset, the API logs a degraded-mode
-- warning and writes plaintext (operator must configure for prod).

create table if not exists public.board_webhooks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.task_boards(id) on delete cascade,
  kind text not null check (kind in ('slack','discord','generic')),
  url text not null,                     -- encrypted at application layer when key set
  secret text,                           -- encrypted at application layer when key set
  events text[] not null default '{}',
  include_description boolean not null default true,
  active boolean not null default true,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references admin_profiles(id)
);

create index if not exists idx_board_webhooks_board on public.board_webhooks (board_id);
