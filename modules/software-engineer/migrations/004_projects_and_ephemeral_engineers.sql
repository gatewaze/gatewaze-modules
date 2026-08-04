-- Phase 2a: the persistent config unit becomes a PROJECT (renamed from se_engineers). A project
-- holds ALL credentials (git PAT + Claude model cred), its repos, shared memory, policy, and a
-- concurrency cap. Engineers are now EPHEMERAL: one per run (se_runs.engineer_name), spawned per
-- issue up to max_concurrent_engineers and gone when the PR merges/closes — there are no persistent
-- engineer rows.
--
-- REWRITTEN (expand/contract, spec §5.9): the original used RENAME COLUMN, which the migration
-- linter forbids — that blocked every deployment that hadn't applied it yet (prod stalled at 003
-- with the module's reconcile failing). Applied deployments skip this file by filename, so the
-- rewrite only ever runs where the original never did. Instead of renaming engineer_id we ADD
-- project_id, backfill, and relax the old column; the dead engineer_id columns are dropped by a
-- later release's contract migration once the linter's window allows. Schema drift vs
-- original-004 deployments: they carry project_id via rename (no residual engineer_id) — both
-- shapes satisfy all code, which only reads/writes project_id.

alter table public.se_engineers rename to se_projects;
alter table public.se_projects
  add column if not exists description text,
  -- Max engineers (runs) a project may have actively working at once. Extra issues stay 'queued'
  -- and dispatch as slots free. The server's worker concurrency is the global ceiling above this.
  add column if not exists max_concurrent_engineers integer not null default 2;

-- Repos + runs reference the project. Expand: add project_id, backfill from engineer_id, then
-- relax engineer_id so new rows need not populate it. FKs on project_id are added guarded (ADD
-- CONSTRAINT has no IF NOT EXISTS); the legacy engineer_id FKs (now pointing at se_projects via
-- the table rename) stay until the contract migration drops the columns.
alter table public.se_repos add column if not exists project_id uuid;
update public.se_repos set project_id = engineer_id where project_id is null;
alter table public.se_repos alter column engineer_id drop not null;
alter table public.se_repos alter column project_id set not null;

alter table public.se_runs add column if not exists project_id uuid;
update public.se_runs set project_id = engineer_id where project_id is null;
alter table public.se_runs alter column engineer_id drop not null;
alter table public.se_runs alter column project_id set not null;

do $guard$
begin
  begin
    alter table public.se_repos
      add constraint se_repos_project_id_fkey foreign key (project_id) references public.se_projects(id) on delete cascade;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.se_runs
      add constraint se_runs_project_id_fkey foreign key (project_id) references public.se_projects(id) on delete cascade;
  exception when duplicate_object then null;
  end;
end
$guard$;

create index if not exists se_repos_project_id_idx on public.se_repos (project_id);
create index if not exists se_runs_project_id_idx on public.se_runs (project_id);

-- Ephemeral engineer label for a run — a friendly auto-assigned name shown in the admin UI so the
-- pool is visible ("Ada on #37, Max on #38"). NOT written into commits/PRs (those are the PAT owner).
alter table public.se_runs add column if not exists engineer_name text;
