-- Overview: drop the "average time to merge" KPI (SPEC.md §14 — Overview tab).
-- The Avg-to-merge tile was removed from the admin Overview UI; this recreates se_overview() so its
-- `totals` payload no longer computes or emits avg_time_to_merge_seconds. Everything else is byte-for-
-- byte the same as migration 007 (KPI totals + status/phase/project rollups). `create or replace`,
-- append-only, idempotent — see 007_overview_metrics.sql for the security rationale (SECURITY INVOKER,
-- respects se_* RLS; the admin API calls it service-role behind its own is_admin() gate).

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
      coalesce(sum(tokens_output), 0)                                       as tokens_output
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
        'runs',           runs,
        'active',         active,
        'merged_30d',     merged_30d,
        'open_prs',       open_prs,
        'failed_blocked', failed_blocked,
        'tokens_input',   tokens_input,
        'tokens_output',  tokens_output
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
