-- tasks module — 004 — per-board custom fields (spec §3.3).

create table if not exists public.board_custom_fields (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.task_boards(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  label text not null,
  field_type text not null check (field_type in (
    'text','number','select','multi_select','date','person','url','boolean'
  )),
  options jsonb,
  required boolean not null default false,
  sort_index integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (board_id, key)
);

create index if not exists idx_board_custom_fields_board
  on public.board_custom_fields (board_id, sort_index)
  where archived = false;
