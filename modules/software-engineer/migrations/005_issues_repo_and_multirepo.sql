-- NEXT-1/NEXT-2: decouple the issues repo from the code repos; multi-repo runs; multi-instance.
-- See SPEC.md §1a (resolved decisions), §2 (work sources), §7 (multi-repo), §12.5 (multi-instance).

-- Project: the (private) issues repo that work is defined in, the trigger label, the primary
-- instance that owns unqualified `agent:build`, and the multi-repo workspace cap.
alter table public.se_projects
  add column if not exists issues_repo_owner        text,
  add column if not exists issues_repo_name         text,
  add column if not exists trigger_label            text not null default 'agent:build',
  add column if not exists primary_instance_id      text,
  add column if not exists max_code_repos_per_run   integer not null default 3;

-- Code repos gain a role: `writable` (agent may change + open a PR) vs `read_only` (cloned for
-- context, never modified); and a per-repo base branch the PR targets (default = repo default).
alter table public.se_repos
  add column if not exists write_mode  text not null default 'writable'
    check (write_mode in ('writable','read_only')),
  add column if not exists base_branch text;

-- Which instance owns a run (multi-instance work claiming; §12.5).
alter table public.se_runs
  add column if not exists instance_id text;

-- Per-repo PRs for a multi-repo run (replaces the single pr_number/pr_url when a run spans repos).
create table if not exists public.se_run_prs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.se_runs(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  repo_owner  text not null,
  repo_name   text not null,
  branch      text,
  pr_number   integer,
  pr_url      text,
  state       text not null default 'open' check (state in ('open','merged','closed_unmerged','error')),
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (run_id, repo_owner, repo_name)
);
create index if not exists se_run_prs_run_idx on public.se_run_prs(run_id);

alter table public.se_run_prs enable row level security;
drop policy if exists se_run_prs_admin_select on public.se_run_prs;
create policy se_run_prs_admin_select on public.se_run_prs
  for select to authenticated using (public.is_admin());
drop policy if exists se_run_prs_admin_all on public.se_run_prs;
create policy se_run_prs_admin_all on public.se_run_prs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop trigger if exists se_run_prs_updated_at on public.se_run_prs;
create trigger se_run_prs_updated_at before update on public.se_run_prs
  for each row execute function public.set_updated_at();

do $$ begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'se_run_prs'
  ) then
    alter publication supabase_realtime add table public.se_run_prs;
  end if;
end $$;
