-- tasks module — 016 — recurrence dedupe state (spec §3.9).

create table if not exists public.task_recurrence_state (
  template_task_id uuid primary key references public.tasks(id) on delete cascade,
  last_spawned_at timestamptz,
  last_spawned_occurrence date,
  next_check_at timestamptz not null default now()
);
