-- tasks module — 001 — boards table (spec §3.1).

create table if not exists public.task_boards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  description text,
  dependency_mode   text not null default 'soft'   check (dependency_mode in ('hard','soft')),
  parent_completion text not null default 'manual' check (parent_completion in ('auto','manual')),
  color text,
  icon text,
  archived boolean not null default false,
  archived_at timestamptz,
  realtime_enabled boolean not null default true,
  kanban_includes  text not null default 'top_only' check (kanban_includes in ('top_only','all')),
  time_zone text,
  created_by uuid references admin_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_task_boards_active
  on public.task_boards (archived, name) where archived = false;
