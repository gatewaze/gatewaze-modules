-- Accurate per-phase cost accounting (reconciliation of seat spend vs recorded spend showed the
-- token-derived book price under-counts ~3.5x: the SDK result's `usage` covers the MAIN thread only,
-- while subagent sessions and the harness's own Haiku utility calls are billed but invisible there).
--
-- cost_usd changes meaning with this migration: it now PREFERS the Agent SDK's total_cost_usd —
-- the harness's own complete meter (subagents + utility models included, list prices) — and only
-- falls back to the book-priced figure when the SDK reports nothing. The book-priced number moves
-- to book_cost_usd for analytics/price-book comparisons. model_usage keeps the SDK's per-model
-- breakdown ({model: {input, output, cacheRead, cacheCreation, costUSD}}) so run views can show
-- where the money went (including harness Haiku), which per-model routing decisions need.
alter table public.se_phases add column if not exists book_cost_usd numeric(10,4);
alter table public.se_phases add column if not exists model_usage jsonb;

comment on column public.se_phases.cost_usd is
  'USD cost of this phase: the Agent SDK''s total_cost_usd when reported (complete: subagents + harness utility calls, list prices), else book-priced from ai_model_prices. Null for non-model phases and pre-012 rows.';
comment on column public.se_phases.book_cost_usd is
  'The ai_model_prices-priced figure for this phase''s MAIN-thread tokens (understates true spend; kept for price-book analytics).';
comment on column public.se_phases.model_usage is
  'Per-model usage/cost breakdown from the Agent SDK result ({model: {input, output, cacheRead, cacheCreation, costUSD}}); live-updated during the phase from streamed assistant usage.';
