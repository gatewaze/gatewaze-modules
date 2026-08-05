-- Human-gated pull request submission. When a project sets pr_submit_mode='manual', the pr phase does
-- NOT open the pull request. The code is complete and the branch is pushed, but the run stops at status
-- 'ready_to_submit' and waits for a person to submit it from the dashboard. This is for work where a
-- human decides when it goes public, e.g. LFX (public linuxfoundation/* repos). Default 'auto' keeps the
-- current behaviour, where the pr phase opens the pull request automatically.
alter table public.se_projects
  add column if not exists pr_submit_mode text not null default 'auto'
    check (pr_submit_mode in ('auto', 'manual'));

comment on column public.se_projects.pr_submit_mode is
  'auto = the pr phase opens the pull request automatically; manual = stop at ready_to_submit for a person to submit from the dashboard.';

-- Allow the new 'ready_to_submit' run status (code complete, branch pushed, PR not yet opened).
alter table public.se_runs drop constraint if exists se_runs_status_check;
alter table public.se_runs add constraint se_runs_status_check
  check (status = any (array[
    'queued','running','blocked','failed','pr_open','watching','changes_requested','merged','closed','cancelled',
    'awaiting_architecture','architecture_in_review','ready_to_submit'
  ]));
