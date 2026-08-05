-- Per-run COST ceiling in USD, enforced at phase start against the run's accumulated
-- se_runs.cost_usd (migration 012). Null = no ceiling. Chosen over the never-enforced
-- per_run_token_ceiling because tokens don't map to spend (cache reads dominate billed input at a
-- tenth of the input rate — a token count is off by ~5x depending on cache mix), while cost_usd is
-- already book-priced per phase. Checked BETWEEN phases: a single runaway phase can overshoot the
-- ceiling by that phase's own cost before the next check (the wall-clock cap bounds that exposure).
alter table public.se_projects add column if not exists per_run_cost_ceiling_usd numeric(10,2);

comment on column public.se_projects.per_run_cost_ceiling_usd is
  'Block a run (cost_ceiling gate) when its accumulated cost_usd reaches this at a phase boundary; null = unlimited. The legacy per_run_token_ceiling column was never enforced and is superseded by this.';
