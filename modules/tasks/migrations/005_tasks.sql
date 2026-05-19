-- tasks module — 005 — tasks table (spec §3.4).

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.task_boards(id) on delete cascade,
  parent_task_id uuid references public.tasks(id) on delete cascade,

  title text not null check (length(title) between 1 and 500),
  description text,

  status_id uuid references public.board_statuses(id) on delete restrict,
  assignee_id uuid references admin_profiles(id) on delete set null,
  priority text check (priority in ('none','low','medium','high','urgent')),
  estimate_hours numeric(8,2) check (estimate_hours is null or estimate_hours >= 0),
  start_date date,
  due_date date,

  sort_index text not null,

  is_done boolean not null default false,
  completed_at timestamptz,

  recurrence_rule text,
  recurrence_parent_id uuid references public.tasks(id) on delete set null,

  due_soon_notified_at timestamptz,
  deleted_at timestamptz,

  created_by uuid references admin_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (start_date is null or due_date is null or start_date <= due_date),
  check (parent_task_id <> id)
);

create index if not exists idx_tasks_board on public.tasks (board_id) where deleted_at is null;
create index if not exists idx_tasks_parent on public.tasks (parent_task_id) where deleted_at is null;
create index if not exists idx_tasks_assignee on public.tasks (assignee_id)
  where assignee_id is not null and deleted_at is null;
create index if not exists idx_tasks_status on public.tasks (status_id) where deleted_at is null;
create index if not exists idx_tasks_due on public.tasks (due_date)
  where due_date is not null and deleted_at is null;
create index if not exists idx_tasks_board_root_order
  on public.tasks (board_id, sort_index)
  where parent_task_id is null and deleted_at is null;
create index if not exists idx_tasks_parent_order
  on public.tasks (parent_task_id, sort_index)
  where parent_task_id is not null and deleted_at is null;
create index if not exists idx_tasks_recurrence_template
  on public.tasks (board_id, recurrence_rule)
  where recurrence_rule is not null and recurrence_parent_id is null and deleted_at is null;
