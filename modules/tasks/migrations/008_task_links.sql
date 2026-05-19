-- tasks module — 008 — polymorphic task links (spec §3.5).

create table if not exists public.task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'events','speakers','content_items','lists','pipelines','forms'
  )),
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references admin_profiles(id),
  unique (task_id, entity_type, entity_id)
);

create index if not exists idx_task_links_entity on public.task_links (entity_type, entity_id);
create index if not exists idx_task_links_task on public.task_links (task_id);
