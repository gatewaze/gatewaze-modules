-- Persisted decisions (issue #52): the Overview "Decisions needed" panel (issue #49) currently
-- re-derives its rows on every GET via classifyDecision() over live se_runs/se_run_prs state — there
-- is no record of the actual QUESTION a run is stuck on, so the panel can only show a plain-language
-- label, never an answerable choice or a text box. se_decisions gives each blocked/awaiting run a
-- durable row: a question, an optional set of 2-4 options, and an answer once the operator responds.
--
-- site_id is added despite the issue's data model omitting it, to match every other se_* table's
-- multi-tenant column (see migration 001's RLS/tenancy pattern); the issue's own `site_id` field name
-- is otherwise NOT used as this module's tenancy key (see project_id below).
create table public.se_decisions (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.se_runs(id) on delete cascade,
  site_id       uuid not null references public.sites(id) on delete cascade,
  -- project_id, not the issue's literal `site_id` field name: this module's actual tenancy/ownership
  -- key for a run is se_runs.project_id (every other se_* table's foreign key agrees).
  project_id    uuid not null references public.se_projects(id) on delete cascade,
  phase         text not null,                     -- current_phase at emission time, for display/debug
  question      text not null,
  kind          text not null check (kind in ('choice', 'text')),
  options       jsonb,                             -- [{id, label, description}], null when kind='text'
  context       text,                              -- skeptic objections digest / proposal link / etc.
  status        text not null default 'pending' check (status in ('pending', 'answered', 'superseded')),
  answer        jsonb,                             -- {option_id} or {text}
  answered_by   text,
  answered_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index se_decisions_run_id_idx on public.se_decisions(run_id);
create index se_decisions_status_idx on public.se_decisions(status, created_at);

-- One pending decision per run, enforced at the DB level: emitting a new decision for a run that
-- already has one pending must supersede the old row first (lib/decisions.ts's
-- createOrSupersedeDecision does this as two statements, not a transaction — see that file's comment
-- for why a rare race there is harmless).
create unique index se_decisions_one_pending_per_run
  on public.se_decisions(run_id) where (status = 'pending');

alter table public.se_decisions enable row level security;
drop policy if exists se_decisions_read on public.se_decisions;
create policy se_decisions_read on public.se_decisions for select to authenticated using (public.is_admin());
drop policy if exists se_decisions_write on public.se_decisions;
create policy se_decisions_write on public.se_decisions for all to authenticated using (public.is_admin()) with check (public.is_admin());
