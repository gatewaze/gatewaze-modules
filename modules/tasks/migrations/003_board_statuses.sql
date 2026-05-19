-- tasks module — 003 — per-board statuses (spec §3.3).

create table if not exists public.board_statuses (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.task_boards(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  color text,
  sort_index integer not null,
  is_done_state boolean not null default false,
  is_default boolean not null default false,
  unique (board_id, sort_index)
);

create index if not exists idx_board_statuses_board
  on public.board_statuses (board_id, sort_index);

create unique index if not exists idx_board_statuses_one_default
  on public.board_statuses (board_id)
  where is_default = true;
