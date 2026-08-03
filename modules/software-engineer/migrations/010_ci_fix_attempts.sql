-- Bounded CI-fix passes. When an open PR's CI has SETTLED red and there is no new trusted review
-- feedback, pr-monitor enqueues a revise in "ci" mode: clone the branch, run the repo's checks, fix
-- the failures, push. This counter caps how many such passes a single run may attempt so an
-- unfixable failure cannot loop forever — after the cap (CI_FIX_CAP in pr-monitor.ts) the run falls
-- back to plain watching and a human takes over.
alter table public.se_runs add column if not exists ci_fix_attempts int not null default 0;

comment on column public.se_runs.ci_fix_attempts is
  'Count of bounded CI-repair revise passes attempted for this run; capped by pr-monitor CI_FIX_CAP.';
