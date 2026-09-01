-- The external-PR Connect flow (admin-routes /prs/connect) inserts kind='external_pr', but the
-- CHECK from 008_interactive_engineers only allowed ('issue','interactive') — every Connect
-- attempt failed with se_runs_kind_check. Widen the constraint to the three kinds the code uses.
alter table public.se_runs drop constraint if exists se_runs_kind_check;
alter table public.se_runs add constraint se_runs_kind_check
  check (kind in ('issue', 'interactive', 'external_pr'));
