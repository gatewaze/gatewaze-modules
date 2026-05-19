-- tasks module — 006 — custom field values per task (spec §3.4).

create table if not exists public.task_field_values (
  task_id uuid not null references public.tasks(id) on delete cascade,
  field_id uuid not null references public.board_custom_fields(id) on delete cascade,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (task_id, field_id)
);

create index if not exists idx_task_field_values_field on public.task_field_values (field_id);
