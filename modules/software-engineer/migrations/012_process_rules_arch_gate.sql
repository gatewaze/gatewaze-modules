-- Per-project development-process rules + an opt-in architecture-review gate (§7.6).
--
-- process_repo/process_path/process_ref: a file OR directory in a roadmap repo holding this
-- project's authoritative development-process rules. The module reads it at the start of every
-- agent phase and injects it into the system prompt (above the generic flow), so each project can
-- encode its own conventions — including "changes to the architecture must go via review first".
--
-- architecture_repo/architecture_ref: the architecture scratch/proposals repo (e.g.
-- linuxfoundation/lfx-architecture-scratch). When set, a new `architecture` phase runs after the spec
-- is approved: if the work is architecture-impacting (per the process rules), the agent writes a
-- proposal to this repo and opens a PR there, and the run BLOCKS until a human merges it — then it
-- auto-resumes to implement. Null/empty = gate off (gatewaze projects behave exactly as before).
alter table public.se_projects
  add column if not exists process_repo      text,
  add column if not exists process_path      text,
  add column if not exists process_ref       text,
  add column if not exists architecture_repo text,
  add column if not exists architecture_ref  text;

comment on column public.se_projects.process_repo is
  'owner/name of the roadmap repo holding this project''s development-process rules (read at run start); null = none.';
comment on column public.se_projects.process_path is
  'File or directory within process_repo holding the rules (default PROCESS.md).';
comment on column public.se_projects.architecture_repo is
  'owner/name of the architecture proposals repo; when set, arch-impacting work opens a proposal PR here and the run blocks for review. Null = gate off.';

-- The run's in-flight architecture proposal PR (in architecture_repo), so pr-monitor can watch it and
-- auto-resume the run to implement when it merges. Status 'awaiting_architecture' marks the blocked run.
alter table public.se_runs
  add column if not exists architecture_repo      text,
  add column if not exists architecture_pr_number int,
  add column if not exists architecture_pr_url    text;

comment on column public.se_runs.architecture_pr_url is
  'URL of this run''s open architecture-proposal PR while it waits at the architecture-review gate.';
