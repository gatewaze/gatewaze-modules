-- Phase 1: first-class Software Engineers + PR lifecycle (archive, two-way PR watch).
--
-- A "Software Engineer" is a named agent persona WITHIN a brand (tenant): its own GitHub token,
-- model credential, assigned repos, commit identity, autonomy + budgets. A brand may have many.
-- This generalises se_brand_settings (which modelled exactly one implicit engineer per brand) into
-- se_engineers; the old table is migrated then dropped.

-- ── se_engineers ────────────────────────────────────────────────────────────
create table if not exists public.se_engineers (
  id                          uuid primary key default gen_random_uuid(),
  site_id                     uuid not null references public.sites(id) on delete cascade,

  name                        text not null,                     -- display name (labels commits/PRs)
  handle                      text,                              -- optional short slug
  avatar_emoji                text,                              -- optional emoji avatar
  owner_user_id               uuid references auth.users(id) on delete set null,  -- optional "acts as" user

  -- GitHub credential (PAT or App installation). Encrypted at rest.
  github_token_ciphertext     text,
  github_token_last4          text,
  github_token_kind           text not null default 'pat' check (github_token_kind in ('pat','app')),
  github_app_installation_id  bigint,
  github_health               text not null default 'unknown'
                              check (github_health in ('unknown','ok','failing')),
  github_checked_at           timestamptz,
  -- Token OWNER identity, derived from GET /user. Commits are authored as this user so a PR looks
  -- like the person whose token it is made it locally (NOT like an agent). Auto-populated on first use.
  github_user_login           text,
  github_user_id              bigint,
  github_user_name            text,

  -- Model credential for the Agent SDK sessions. Encrypted at rest.
  model_cred_ciphertext       text,
  model_cred_last4            text,
  model_cred_kind             text not null default 'anthropic_api_key'
                              check (model_cred_kind in
                                ('anthropic_api_key','claude_code_oauth_token','bedrock','vertex')),
  model                       text not null default 'claude-opus-4-8',
  model_health                text not null default 'unknown'
                              check (model_health in ('unknown','ok','failing')),
  model_checked_at            timestamptz,

  -- Optional manual override of the git author (defaults to the derived token-owner identity above).
  commit_author_name          text,
  commit_author_email         text,

  -- Behaviour + guardrails.
  allowed_labellers           text[] not null default '{}',
  intake_enabled              boolean not null default false,
  autonomy_mode               text not null default 'pr_only'
                              check (autonomy_mode in ('pr_only','auto_merge_safe')),
  monthly_token_budget        bigint,
  per_run_token_ceiling       bigint,
  per_run_wallclock_minutes   integer,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists se_engineers_site_idx on public.se_engineers(site_id);

-- ── migrate se_brand_settings → one engineer per brand ──────────────────────
insert into public.se_engineers (
  site_id, name,
  github_token_ciphertext, github_token_last4, github_token_kind, github_app_installation_id,
  github_health, github_checked_at,
  model_cred_ciphertext, model_cred_last4, model_cred_kind, model, model_health, model_checked_at,
  commit_author_name, commit_author_email,
  allowed_labellers, intake_enabled, autonomy_mode,
  monthly_token_budget, per_run_token_ceiling, per_run_wallclock_minutes
)
select
  bs.site_id, coalesce(nullif(btrim(bs.commit_author_name), ''), 'Software Engineer'),
  bs.github_token_ciphertext, bs.github_token_last4, bs.github_token_kind, bs.github_app_installation_id,
  bs.github_health, bs.github_checked_at,
  bs.model_cred_ciphertext, bs.model_cred_last4, bs.model_cred_kind, bs.model, bs.model_health, bs.model_checked_at,
  bs.commit_author_name, bs.commit_author_email,
  bs.allowed_labellers, bs.intake_enabled, bs.autonomy_mode,
  bs.monthly_token_budget, bs.per_run_token_ceiling, bs.per_run_wallclock_minutes
from public.se_brand_settings bs
where not exists (select 1 from public.se_engineers e where e.site_id = bs.site_id);

-- ── se_repos: assign each repo to an engineer ───────────────────────────────
alter table public.se_repos
  add column if not exists engineer_id uuid references public.se_engineers(id) on delete cascade;
update public.se_repos r
  set engineer_id = e.id
  from public.se_engineers e
  where e.site_id = r.site_id and r.engineer_id is null;
create index if not exists se_repos_engineer_idx on public.se_repos(engineer_id);

-- ── se_runs: engineer link + archive + PR-watch state ───────────────────────
alter table public.se_runs
  add column if not exists engineer_id   uuid references public.se_engineers(id) on delete set null,
  add column if not exists archived_at   timestamptz,
  add column if not exists revise_count  integer not null default 0,
  add column if not exists pr_state      text,          -- open|changes_requested|approved|merged|closed
  add column if not exists pr_seen_at    timestamptz,   -- newest review/comment activity already handled
  add column if not exists pr_checked_at timestamptz;   -- last time the monitor polled the PR
update public.se_runs r
  set engineer_id = e.id
  from public.se_engineers e
  where e.site_id = r.site_id and r.engineer_id is null;
create index if not exists se_runs_engineer_idx on public.se_runs(engineer_id);
-- The PR monitor scans only live, non-archived runs.
create index if not exists se_runs_monitor_idx on public.se_runs(status) where archived_at is null;

-- Widen the state machine: PR-watch statuses + the revise/reflect/watch phases.
alter table public.se_runs drop constraint if exists se_runs_status_check;
alter table public.se_runs add constraint se_runs_status_check
  check (status in ('queued','running','blocked','failed','pr_open','watching','changes_requested','merged','closed','cancelled'));
alter table public.se_runs drop constraint if exists se_runs_current_phase_check;
alter table public.se_runs add constraint se_runs_current_phase_check
  check (current_phase in ('intake','spec','review','implement','verify','pr','merge','revise','reflect','watch'));

-- ── RLS: admin-only, mirroring the other se_* tables ────────────────────────
alter table public.se_engineers enable row level security;
drop policy if exists se_engineers_admin_select on public.se_engineers;
create policy se_engineers_admin_select on public.se_engineers
  for select to authenticated using (public.is_admin());
drop policy if exists se_engineers_admin_all on public.se_engineers;
create policy se_engineers_admin_all on public.se_engineers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop trigger if exists se_engineers_updated_at on public.se_engineers;
create trigger se_engineers_updated_at
  before update on public.se_engineers
  for each row execute function public.set_updated_at();

-- ── drop the superseded per-brand table (data migrated above) ───────────────
drop table if exists public.se_brand_settings;
