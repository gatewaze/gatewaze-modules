-- Support computeSpendOverview()'s access pattern (lib/cost.ts): a 30-day scan of costed runs,
-- filtered on `cost_usd is not null` and `created_at >= now() - 30d`. se_runs previously had no
-- index covering this combination (only (site_id, status) and project_id), so the query fell back
-- to a full-table scan that grows with total run volume. Partial index matches the filter exactly.
create index if not exists se_runs_created_at_cost_idx
  on public.se_runs (created_at)
  where cost_usd is not null;
