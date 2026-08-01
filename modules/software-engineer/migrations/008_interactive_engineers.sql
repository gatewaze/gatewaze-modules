-- Interactive (pair-programming) engineer sessions.
--
-- Today a run is always driven by a labelled issue and runs a fixed pipeline (spec → … → PR) that
-- terminates itself. This adds a second run KIND: `interactive` — a manually-started, long-lived
-- Claude Code session on a project that an admin just chats with (desktop pair-programming feel).
-- It reuses the whole run/transcript/chat/worktree stack, but there is no issue and no pipeline: one
-- persistent streaming session runs until it is explicitly CLOSED (or hits an idle / wall-clock cap).
-- Because it never works an issue to completion, nothing would ever close it on its own — hence the
-- explicit close control + caps. See workers/interactive.ts.
--
-- Idempotent.

-- Run kind. Existing rows are issue-driven runs (the default).
alter table public.se_runs
  add column if not exists kind text not null default 'issue'
    check (kind in ('issue', 'interactive'));

-- Interactive runs have no triggering issue, so issue_number is optional for them. (The live-issue
-- uniqueness index is unaffected: NULLs are distinct in a Postgres unique index, so many concurrent
-- interactive runs on the same project never collide.)
alter table public.se_runs alter column issue_number drop not null;

-- Allow the `interactive` pseudo-phase on a run. (se_events.phase is unconstrained free text, so live
-- events + chat under this phase need no change; interactive runs record no se_phases rows.)
alter table public.se_runs drop constraint if exists se_runs_current_phase_check;
alter table public.se_runs add constraint se_runs_current_phase_check
  check (current_phase in
    ('intake','spec','review','implement','verify','pr','merge','revise','reflect','watch','interactive'));

-- Fast lookup of a project's live interactive sessions (cap enforcement + the runs board).
create index if not exists se_runs_interactive_idx
  on public.se_runs (project_id, status) where kind = 'interactive' and archived_at is null;

-- Per-project cap on concurrently-open interactive sessions. Separate from max_concurrent_engineers
-- (the issue pipeline pool): each open session holds one runner worker for its whole lifetime, so the
-- default is deliberately conservative.
alter table public.se_projects
  add column if not exists max_interactive_engineers integer not null default 1;
