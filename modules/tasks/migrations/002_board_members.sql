-- tasks module — 002 — board membership + role helper view (spec §3.2).

create table if not exists public.board_members (
  board_id uuid not null references public.task_boards(id) on delete cascade,
  admin_profile_id uuid not null references admin_profiles(id) on delete cascade,
  role text not null check (role in ('owner','editor','viewer')),
  added_at timestamptz not null default now(),
  added_by uuid references admin_profiles(id),
  primary key (board_id, admin_profile_id)
);

create index if not exists idx_board_members_user on public.board_members (admin_profile_id);

create or replace view public.board_member_role_v
with (security_invoker = on) as
  select bm.board_id, bm.admin_profile_id, bm.role
    from public.board_members bm;
