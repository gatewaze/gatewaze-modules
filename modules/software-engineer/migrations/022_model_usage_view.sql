-- Per-(run, phase, model) usage unrolled from se_phases.model_usage.
--
-- Why: se_phases.model_usage is the SUBAGENT- and utility-model-inclusive breakdown of a phase's
-- spend, whereas the flat se_phases.tokens_* columns are MAIN-THREAD only (they miss the parallel
-- subagent sessions a phase spawns — e.g. spec fans out explorer subagents at ~3x the main-thread
-- token volume). This view unrolls that JSONB into one row per model so the Overview can attribute
-- spend per model (subagents included), not just per-run totals.
--
-- security_invoker = true: the view executes with the QUERYING role's privileges, so se_phases'
-- row-level security (select to authenticated using public.is_admin()) is enforced THROUGH the view.
-- SELECT is granted to authenticated + service_role (as se_overview does), but a non-admin therefore
-- sees zero rows; the admin API reads it with the service role (RLS-exempt) and is already
-- is_admin-gated at the platform layer.
create or replace view public.se_phase_model_usage
  with (security_invoker = true) as
select
  ph.run_id,
  r.project_id,
  ph.site_id,
  ph.phase,
  ph.attempt,
  ph.finished_at,
  mu.key                                             as model,
  coalesce((mu.value ->> 'input')::bigint, 0)         as tokens_input,
  coalesce((mu.value ->> 'output')::bigint, 0)        as tokens_output,
  coalesce((mu.value ->> 'cacheRead')::bigint, 0)     as tokens_cache_read,
  coalesce((mu.value ->> 'cacheCreation')::bigint, 0) as tokens_cache_creation,
  coalesce((mu.value ->> 'costUSD')::numeric, 0)      as cost_usd
from public.se_phases ph
join public.se_runs r on r.id = ph.run_id
cross join lateral jsonb_each(coalesce(ph.model_usage, '{}'::jsonb)) as mu(key, value);

-- Grant SELECT to both roles (mirrors se_overview): the view's security_invoker means se_phases'
-- is_admin() RLS still filters an authenticated non-admin to zero rows, while the service-role API
-- (RLS-exempt, already is_admin-gated at the platform layer) reads all rows.
grant select on public.se_phase_model_usage to authenticated, service_role;

comment on view public.se_phase_model_usage is
  'Unrolled per-(run,phase,model) token/cost from se_phases.model_usage — subagent- and utility-model-inclusive (flat se_phases.tokens_* are main-thread only). security_invoker so se_phases is_admin() RLS applies to authenticated callers.';

-- Grouped rollup for the Overview "spend by model" report. Aggregates in the DB (not in the API) so
-- it is not subject to PostgREST's default row cap over a wide window. SECURITY INVOKER + the view's
-- security_invoker mean se_phases' is_admin() RLS still gates a direct caller (an authenticated
-- non-admin gets zero rows); the service-role API reads all. Mirrors se_overview's posture exactly.
create or replace function public.se_model_usage(p_project uuid default null, p_days int default 7)
returns table (
  model text,
  phases bigint,
  tokens_input bigint,
  tokens_output bigint,
  tokens_cache_read bigint,
  tokens_cache_creation bigint,
  cost_usd numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    u.model,
    count(*)                        as phases,
    sum(u.tokens_input)             as tokens_input,
    sum(u.tokens_output)            as tokens_output,
    sum(u.tokens_cache_read)        as tokens_cache_read,
    sum(u.tokens_cache_creation)    as tokens_cache_creation,
    round(sum(u.cost_usd), 4)       as cost_usd
  from public.se_phase_model_usage u
  where u.finished_at >= now() - make_interval(days => greatest(1, least(365, coalesce(p_days, 7))))
    and (p_project is null or u.project_id = p_project)
  group by u.model
  order by cost_usd desc nulls last;
$$;

grant execute on function public.se_model_usage(uuid, int) to authenticated, service_role;
