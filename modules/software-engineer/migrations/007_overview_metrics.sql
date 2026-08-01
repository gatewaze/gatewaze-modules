-- Overview dashboard metrics (SPEC.md §14 — Overview tab).
-- A single read-only aggregation function the admin Overview tab calls once (via RPC) to render
-- KPI tiles + status/phase/project rollups, instead of pulling every run row to the client and
-- aggregating in JS. Pure SELECTs, no writes.
--
-- SECURITY INVOKER (the default): the underlying se_* tables are admin-only under RLS, so an
-- authenticated caller only ever aggregates rows they may already read; the module's admin API
-- calls it with the service-role client (which bypasses RLS) behind its own is_admin() gate.
-- Idempotent.

create or replace function public.se_overview(p_project uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with runs as (
    -- Archived runs stay in the historical totals (archiving is a UI dismissal, not a delete);
    -- "active" is derived from live statuses below, so archived runs never inflate it.
    select *
    from public.se_runs r
    where p_project is null or r.project_id = p_project
  ),
  totals as (
    select
      count(*)                                                              as runs,
      count(*) filter (
        where status in ('queued','running','blocked','watching','changes_requested','pr_open')
          and archived_at is null
      )                                                                     as active,
      count(*) filter (where status = 'merged' and updated_at >= now() - interval '30 days') as merged_30d,
      count(*) filter (where status in ('pr_open','watching','changes_requested'))           as open_prs,
      count(*) filter (where status in ('failed','blocked'))                                 as failed_blocked,
      coalesce(sum(tokens_input), 0)                                        as tokens_input,
      coalesce(sum(tokens_output), 0)                                       as tokens_output,
      -- Time-to-merge proxy: merge flips status→'merged' and touches updated_at; start is the run's
      -- first work (started_at, else created_at). Averaged over merged runs in the last 30 days.
      (
        select avg(extract(epoch from (updated_at - coalesce(started_at, created_at))))::bigint
        from runs
        where status = 'merged'
          and updated_at >= now() - interval '30 days'
          and updated_at >= coalesce(started_at, created_at)
      )                                                                     as avg_time_to_merge_seconds
    from runs
  ),
  by_status as (
    select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', c) order by c desc), '[]'::jsonb) as v
    from (select status, count(*) c from runs group by status) s
  ),
  by_phase as (
    -- Distribution of live runs across pipeline stages (where work currently sits).
    select coalesce(jsonb_agg(jsonb_build_object('phase', current_phase, 'count', c) order by c desc), '[]'::jsonb) as v
    from (
      select current_phase, count(*) c
      from runs
      where status in ('queued','running','blocked','watching','changes_requested','pr_open')
        and archived_at is null
      group by current_phase
    ) p
  ),
  by_project as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'project_id',     pr.project_id,
        'name',           pj.name,
        'avatar_emoji',   pj.avatar_emoji,
        'total',          pr.total,
        'active',         pr.active,
        'merged',         pr.merged,
        'failed_blocked', pr.failed_blocked,
        'tokens_input',   pr.tokens_input,
        'tokens_output',  pr.tokens_output
      ) order by pr.total desc
    ), '[]'::jsonb) as v
    from (
      select
        project_id,
        count(*)                                                                              as total,
        count(*) filter (
          where status in ('queued','running','blocked','watching','changes_requested','pr_open')
            and archived_at is null
        )                                                                                     as active,
        count(*) filter (where status = 'merged')                                             as merged,
        count(*) filter (where status in ('failed','blocked'))                                as failed_blocked,
        coalesce(sum(tokens_input), 0)                                                        as tokens_input,
        coalesce(sum(tokens_output), 0)                                                       as tokens_output
      from runs
      where project_id is not null
      group by project_id
    ) pr
    left join public.se_projects pj on pj.id = pr.project_id
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'runs',                      runs,
        'active',                    active,
        'merged_30d',                merged_30d,
        'open_prs',                  open_prs,
        'failed_blocked',            failed_blocked,
        'tokens_input',              tokens_input,
        'tokens_output',             tokens_output,
        'avg_time_to_merge_seconds', avg_time_to_merge_seconds
      ) from totals
    ),
    'by_status',  (select v from by_status),
    'by_phase',   (select v from by_phase),
    'by_project', (select v from by_project)
  );
$$;

comment on function public.se_overview(uuid) is
  'Read-only Overview metrics for the software-engineer dashboard: KPI totals + status/phase/project rollups. Optional project filter. SECURITY INVOKER — respects se_* RLS.';

-- Admin UI reads via the module API (service-role); authenticated direct callers still pass RLS.
grant execute on function public.se_overview(uuid) to authenticated, service_role;
