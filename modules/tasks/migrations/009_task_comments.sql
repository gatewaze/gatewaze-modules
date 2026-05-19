-- tasks module — 009 — task comments (spec §3.6).

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid not null references admin_profiles(id),
  body text not null check (length(body) between 1 and 20000),
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_task_comments_task
  on public.task_comments (task_id, created_at)
  where deleted_at is null;
