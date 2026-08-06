-- Phase gates + strict Plan-vs-Advance authorization (spec gate).
--
-- Adds the human spec gate (status 'awaiting_spec') that parks a run after the agent's skeptic
-- self-review, before implementation, so a reviewer can chat to refine the spec and an approver can
-- approve it. Adds the per-project gate config and approver list, and the per-run refine counter that
-- backs the per-run refine budget. The architecture gate (016) and submission gate (017, pr_submit_mode)
-- already exist and are unchanged.

-- 1) spec gate status.
alter table public.se_runs drop constraint if exists se_runs_status_check;
alter table public.se_runs add constraint se_runs_status_check
  check (status = any (array[
    'queued','running','blocked','failed','pr_open','watching','changes_requested','merged','closed','cancelled',
    'awaiting_architecture','architecture_in_review','ready_to_submit','awaiting_spec'
  ]));

-- 2) per-project gate config, approver list, and refine budget.
--    gates: which human gates are on, e.g. {"spec": true}. The architecture gate stays keyed on
--    architecture_repo and the submission gate stays keyed on pr_submit_mode; gates.spec is the new one.
--    approvers: gatewaze user ids allowed to do Advance actions (approve, finalize, submit, merge). Empty
--    means the project is not restricted and any admin may advance, which keeps current behavior; a
--    non-empty list restricts Advance to those users, independent of platform admin.
alter table public.se_projects
  add column if not exists gates          jsonb  not null default '{}'::jsonb,
  add column if not exists approvers      uuid[] not null default '{}'::uuid[],
  add column if not exists refine_budget  int;

comment on column public.se_projects.approvers is
  'Gatewaze user ids allowed to advance a run past a gate (approve/finalize/submit/merge). Empty = unrestricted (any admin); non-empty = only these users, independent of platform admin role.';
comment on column public.se_projects.refine_budget is
  'Max chat-to-refine rounds per run before further refine requests are held; null = unlimited.';

-- 3) per-run refine counter (enforces refine_budget).
alter table public.se_runs
  add column if not exists refine_count int not null default 0;
