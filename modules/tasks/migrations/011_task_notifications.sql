-- tasks module — 011 — per-user notification inbox (spec §3.7).

create table if not exists public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references admin_profiles(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null check (kind in (
    'assigned','mentioned','comment_on_followed',
    'due_soon','status_changed_for_followed'
  )),
  payload jsonb,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_notifications_unread
  on public.task_notifications (recipient_id, created_at desc)
  where read_at is null;
create index if not exists idx_task_notifications_user
  on public.task_notifications (recipient_id, created_at desc);
