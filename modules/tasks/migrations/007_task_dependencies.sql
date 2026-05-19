-- tasks module — 007 — task dependencies (spec §3.5).

create table if not exists public.task_dependencies (
  blocker_id uuid not null references public.tasks(id) on delete cascade,
  blocked_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references admin_profiles(id),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists idx_task_deps_blocked on public.task_dependencies (blocked_id);
