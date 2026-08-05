-- Per-project credential model (§12 of the phase-gates spec): role-scoped credentials and an optional
-- per-user credential mode, plus the gatewaze-user-to-GitHub-user identity map.
--
-- Backward compatible: credential_mode defaults to 'shared' and every role-scoped slot is nullable and
-- falls back to the project's existing default PAT / model credential. A project that changes nothing
-- behaves exactly as before. All credential material is encrypted the same way the existing project
-- credentials are (the module's AES-256-GCM seal), stored as ciphertext, never returned to the client.

-- 1) role-scoped credential slots + the credential mode on the project.
--    committing/commenting/pull_request PATs each fall back to github_token when null; the coding-agent
--    model credential falls back to model_cred when null.
alter table public.se_projects
  add column if not exists credential_mode              text not null default 'shared'
                                                        check (credential_mode in ('shared','per_user','mixed')),
  add column if not exists committing_pat_ciphertext    text,
  add column if not exists committing_pat_last4         text,
  add column if not exists commenting_pat_ciphertext    text,
  add column if not exists commenting_pat_last4         text,
  add column if not exists pull_request_pat_ciphertext  text,
  add column if not exists pull_request_pat_last4       text,
  add column if not exists coding_agent_model_ciphertext text,
  add column if not exists coding_agent_model_last4     text;

comment on column public.se_projects.credential_mode is
  'shared = every run uses the project credentials; per_user = the acting user''s own credentials; mixed = shared coding-agent credential but the acting user''s git identity. See spec §12.';

-- 2) per-user credentials (for per_user and mixed modes). Encrypted, scoped to a user (and optionally a
--    project; a null project_id is a user default across projects).
create table if not exists public.se_user_credentials (
  id                     uuid primary key default gen_random_uuid(),
  site_id                uuid not null references public.sites(id) on delete cascade,
  user_id                uuid not null,
  project_id             uuid references public.se_projects(id) on delete cascade,
  github_pat_ciphertext  text,
  github_pat_last4       text,
  model_cred_ciphertext  text,
  model_cred_last4       text,
  codex_cred_ciphertext  text,
  codex_cred_last4       text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (site_id, user_id, project_id)
);
create index if not exists se_user_credentials_user_idx on public.se_user_credentials (user_id);

-- 3) gatewaze-user-to-GitHub-user identity map, keyed by email (spec §6.3). Links a gatewaze user to a
--    GitHub login so a GitHub reporter can be matched to a gatewaze user and an acting user's credentials
--    can be resolved. project_id null = a global mapping for that user.
create table if not exists public.se_identity_map (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.sites(id) on delete cascade,
  user_id      uuid not null,
  github_login text not null,
  email        text,
  project_id   uuid references public.se_projects(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (site_id, user_id, github_login)
);
create index if not exists se_identity_map_user_idx  on public.se_identity_map (user_id);
create index if not exists se_identity_map_login_idx on public.se_identity_map (github_login);

-- 4) the run records which gatewaze user's credentials it should act as (set at trigger/advance time for
--    per_user / mixed modes; null = the project default). Resolved by the credential helper.
alter table public.se_runs
  add column if not exists acting_user_id uuid;
