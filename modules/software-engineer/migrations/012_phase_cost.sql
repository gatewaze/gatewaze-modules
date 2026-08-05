-- Per-phase cost + full token accounting. usage.input_tokens alone is only the UNCACHED input
-- remainder — cache reads/writes dominate billed input in agentic sessions (observed 5-6x gap
-- between token-derived estimates and actual spend), so phases now record the cache token split
-- and a computed cost. Cost is priced from the ai module's operator-editable price book
-- (public.ai_model_prices, litellm-refreshed) when the model has a row there, falling back to the
-- Agent SDK's own total_cost_usd; see lib/cost.ts.
alter table public.se_phases add column if not exists tokens_cache_read bigint not null default 0;
alter table public.se_phases add column if not exists tokens_cache_creation bigint not null default 0;
alter table public.se_phases add column if not exists cost_usd numeric(10,4);

-- Denormalised run total (sum of its phases' cost_usd), recomputed by recordPhaseEnd after each
-- phase closes so the runs LIST endpoint can show cost without joining se_phases.
alter table public.se_runs add column if not exists cost_usd numeric(10,4);

comment on column public.se_phases.cost_usd is
  'USD cost of this phase: priced from ai_model_prices (cache-aware) when available, else the Agent SDK''s reported total_cost_usd. Null for non-model phases and rows recorded before this column existed.';
comment on column public.se_runs.cost_usd is
  'Sum of this run''s se_phases.cost_usd, maintained by recordPhaseEnd. Null until a costed phase completes.';
