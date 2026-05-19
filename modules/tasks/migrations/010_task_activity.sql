-- tasks module — 010 — auto-logged activity feed (spec §3.6).

create table if not exists public.task_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid references admin_profiles(id),
  event_type text not null check (event_type in (
    'created','title_changed','description_changed',
    'status_changed','assignee_changed','priority_changed',
    'estimate_changed','start_date_changed','due_date_changed',
    'parent_changed','dependency_added','dependency_removed',
    'link_added','link_removed','comment_added',
    'auto_completed_parent','recurrence_spawned',
    'reordered','soft_deleted','restored'
  )),
  payload jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_task_activity_task
  on public.task_activity (task_id, occurred_at desc);
create index if not exists idx_task_activity_actor
  on public.task_activity (actor_id, occurred_at desc);
