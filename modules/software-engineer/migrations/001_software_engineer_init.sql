-- ============================================================================
-- Module: software-engineer
-- Migration: 001_software_engineer_init
-- Spec: gatewaze/docs/spec-software-engineer.md §12
-- Description: Multi-tenant (per-brand / site_id) schema for the autonomous
--   issue → PR engineering agent.
--     se_brand_settings — one row per brand: encrypted GitHub + model credentials,
--                         budgets, autonomy mode, kill switch. Secrets stored as
--                         *_ciphertext (AES-256-GCM via @gatewaze/shared/modules) +
--                         *_last4; cleartext is NEVER stored or returned.
--     se_repos          — monitored repos per brand; repo→brand resolution key.
--     se_runs           — one run per triggered issue (the pipeline state machine).
--     se_phases         — per-phase execution records (tokens, status, timing).
--     se_gates          — audit trail of every safety-gate decision.
--     se_artifacts      — spec / review / diff / reports / pr, per run.
--     se_events         — live agent event stream (realtime-published) for the
--                         "watch the agent" admin view.
--   RLS: admin-only everywhere (this is operator infrastructure). Workers write
--   via the service-role client, which bypasses RLS by design.
--   Idempotent.
-- ============================================================================

-- ── Per-brand settings + credentials ────────────────────────────────────────
create table if not exists public.se_brand_settings (
  site_id                     uuid primary key references public.sites(id) on delete cascade,

  -- GitHub credential (PAT or App installation). Encrypted at rest.
  github_token_ciphertext     text,
  github_token_last4          text,
  github_token_kind           text not null default 'pat' check (github_token_kind in ('pat','app')),
  github_app_installation_id  bigint,
  github_health               text not null default 'unknown'
                              check (github_health in ('unknown','ok','failing')),
  github_checked_at           timestamptz,

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

comment on table public.se_brand_settings is
  'Per-brand config for the software-engineer module. Credentials are AES-256-GCM encrypted; cleartext is never stored or returned by any API.';

-- ── Monitored repos (repo→brand resolution) ─────────────────────────────────
create table if not exists public.se_repos (
  id                    uuid primary key default gen_random_uuid(),
  site_id               uuid not null references public.sites(id) on delete cascade,
  repo_owner            text not null,
  repo_name             text not null,
  enabled               boolean not null default true,
  contract_ok           boolean not null default false,   -- CLAUDE.md + .claude/rules present
  branch_protection_ok  boolean not null default false,   -- required checks configured
  merge_eligible        boolean not null default false,   -- derived: contract + protection + non-bypass token
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A repo maps to exactly one brand within a deployment (the resolution key).
  constraint se_repos_owner_name_unique unique (repo_owner, repo_name)
);
create index if not exists se_repos_site_idx on public.se_repos (site_id);

-- ── Runs (pipeline state machine) ───────────────────────────────────────────
create table if not exists public.se_runs (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id) on delete cascade,
  repo_owner      text not null,
  repo_name       text not null,
  issue_number    integer not null,
  issue_node_id   text,
  title           text,
  labeller        text,
  status          text not null default 'queued'
                  check (status in ('queued','running','blocked','failed','pr_open','merged','cancelled')),
  current_phase   text not null default 'intake'
                  check (current_phase in ('intake','spec','review','implement','verify','pr','merge')),
  branch_name     text,
  pr_number       integer,
  pr_url          text,
  blast_radius    text not null default 'unknown' check (blast_radius in ('unknown','safe','needs_human')),
  retry_count     integer not null default 0,
  tokens_input    bigint not null default 0,
  tokens_output   bigint not null default 0,
  started_at      timestamptz,
  error           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists se_runs_site_status_idx on public.se_runs (site_id, status);
-- Idempotency: at most one live run per issue.
create unique index if not exists se_runs_live_issue_uidx
  on public.se_runs (site_id, repo_owner, repo_name, issue_number)
  where status in ('queued','running','blocked');

-- ── Phases ──────────────────────────────────────────────────────────────────
create table if not exists public.se_phases (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.se_runs(id) on delete cascade,
  site_id        uuid not null references public.sites(id) on delete cascade,
  phase          text not null
                 check (phase in ('intake','spec','review','implement','verify','pr','merge')),
  status         text not null default 'pending'
                 check (status in ('pending','running','passed','failed','blocked','skipped')),
  attempt        integer not null default 1,
  model          text,
  tokens_input   bigint not null default 0,
  tokens_output  bigint not null default 0,
  summary        text,
  error          text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint se_phases_run_phase_attempt_unique unique (run_id, phase, attempt)
);
create index if not exists se_phases_run_idx on public.se_phases (run_id);

-- ── Gate decisions (audit) ──────────────────────────────────────────────────
create table if not exists public.se_gates (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.se_runs(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  gate        text not null
              check (gate in ('authorization','adversarial_review','security','ci','blast_radius','budget','kill_switch')),
  verdict     text not null check (verdict in ('pass','block')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists se_gates_run_idx on public.se_gates (run_id);

-- ── Artifacts ───────────────────────────────────────────────────────────────
create table if not exists public.se_artifacts (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.se_runs(id) on delete cascade,
  site_id       uuid not null references public.sites(id) on delete cascade,
  phase         text,
  kind          text not null
                check (kind in ('spec','review','diff','security_report','ci_report','pr')),
  content       text,
  storage_path  text,
  created_at    timestamptz not null default now()
);
create index if not exists se_artifacts_run_idx on public.se_artifacts (run_id);

-- ── Live event stream (realtime-published) ──────────────────────────────────
create table if not exists public.se_events (
  id          bigserial primary key,
  run_id      uuid not null references public.se_runs(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  phase       text,
  seq         integer not null default 0,
  kind        text not null
              check (kind in ('assistant','tool_use','tool_result','thinking','status','gate')),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists se_events_run_seq_idx on public.se_events (run_id, seq);

-- ── Interactive messages (admin ↔ agent chat; §14.1) ────────────────────────
-- Admin messages are injected into the live session via Redis (se:input:<run_id>)
-- and streamInput(); agent replies are recorded here for the chat transcript.
create table if not exists public.se_messages (
  id              bigserial primary key,
  run_id          uuid not null references public.se_runs(id) on delete cascade,
  site_id         uuid not null references public.sites(id) on delete cascade,
  sub_session_id  text,                       -- which agent lane (null = the phase's top session)
  role            text not null check (role in ('admin','agent','system')),
  author          uuid references auth.users(id) on delete set null,  -- set for role='admin'
  content         text not null,
  delivered_at    timestamptz,                -- set by the runner when injected into the session
  created_at      timestamptz not null default now()
);
create index if not exists se_messages_run_idx on public.se_messages (run_id, id);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists se_brand_settings_updated_at on public.se_brand_settings;
create trigger se_brand_settings_updated_at
  before update on public.se_brand_settings
  for each row execute function public.set_updated_at();

drop trigger if exists se_repos_updated_at on public.se_repos;
create trigger se_repos_updated_at
  before update on public.se_repos
  for each row execute function public.set_updated_at();

drop trigger if exists se_runs_updated_at on public.se_runs;
create trigger se_runs_updated_at
  before update on public.se_runs
  for each row execute function public.set_updated_at();

-- ── RLS: admin-only (operator infrastructure). Workers use service-role. ─────
do $$
declare t text;
begin
  foreach t in array array[
    'se_brand_settings','se_repos','se_runs','se_phases','se_gates','se_artifacts','se_events','se_messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_write', t);
  end loop;
end $$;

-- ── Realtime: publish the live-view tables for the admin "watch the agent" UI ─
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['se_runs','se_phases','se_events','se_messages'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
