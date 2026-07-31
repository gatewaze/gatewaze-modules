-- Phase 2a: the persistent config unit becomes a PROJECT (renamed from se_engineers). A project
-- holds ALL credentials (git PAT + Claude model cred), its repos, shared memory, policy, and a
-- concurrency cap. Engineers are now EPHEMERAL: one per run (se_runs.engineer_name), spawned per
-- issue up to max_concurrent_engineers and gone when the PR merges/closes — there are no persistent
-- engineer rows. This is largely a rename: Phase 1's "engineer" already held exactly this data.

alter table public.se_engineers rename to se_projects;
alter table public.se_projects
  add column if not exists description text,
  -- Max engineers (runs) a project may have actively working at once. Extra issues stay 'queued'
  -- and dispatch as slots free. The server's worker concurrency is the global ceiling above this.
  add column if not exists max_concurrent_engineers integer not null default 2;

-- Repos + runs now reference the project (the FKs + indexes follow the column rename).
alter table public.se_repos rename column engineer_id to project_id;
alter table public.se_runs  rename column engineer_id to project_id;

-- Ephemeral engineer label for a run — a friendly auto-assigned name shown in the admin UI so the
-- pool is visible ("Ada on #37, Max on #38"). NOT written into commits/PRs (those are the PAT owner).
alter table public.se_runs add column if not exists engineer_name text;
