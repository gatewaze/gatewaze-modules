-- Reporter-safe feedback link: lets an external intake module (e.g. health-core) track a tester's
-- report through to the run that implements it, and lets a run ask that reporter a focused product
-- clarification question, without exposing se_decisions/se_messages (admin-only) to the tester.
--
-- This is deliberately a SEPARATE surface from se_decisions. se_decisions answers (architecture
-- approval, spec gate, PR gate) can only ever be written by an authenticated admin via admin-routes.ts
-- (gated by is_admin() + denyIfNotApprover). A reporter answer here can NEVER advance a project gate by
-- itself — the only effect of answering a reporter question is that the answer is appended to
-- se_messages (role='reporter') for spec-refine.ts to read as untrusted input, same as an admin chat
-- note. The actual gate (approving the spec, approving architecture, merging) still requires an admin.
--
-- All three tables are RLS-locked to is_admin() like se_decisions/se_messages: no tester ever talks to
-- Postgres directly. The intake module calls this module's internal API
-- (/api/modules/software-engineer/internal/reporter-*, authenticated via the shared
-- x-gatewaze-internal-key service-to-service header — see lib/memory.ts for the existing convention),
-- which runs under the service role and performs the tester-ownership check itself before ever reaching
-- here.

create table if not exists public.se_reporter_links (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.se_runs(id) on delete cascade,
  site_id             uuid not null references public.sites(id) on delete cascade,
  external_system     text not null check (external_system in ('health_core')),
  external_report_id  uuid not null,
  external_person_id  uuid not null,
  is_primary          boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (external_system, external_report_id)
);
create index if not exists se_reporter_links_run_idx on public.se_reporter_links (run_id);
create index if not exists se_reporter_links_person_idx on public.se_reporter_links (external_system, external_person_id);

alter table public.se_reporter_links enable row level security;
create policy se_reporter_links_admin on public.se_reporter_links
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- One pending reporter question per run, same shape/invariant as se_decisions_one_pending_per_run.
create table if not exists public.se_reporter_questions (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.se_runs(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  phase       text not null,
  question    text not null,
  kind        text not null check (kind in ('choice', 'text')),
  options     jsonb,
  summary     text not null,   -- plain-language feature summary the reporter is confirming/revising
  revision    int not null default 1,
  status      text not null default 'pending' check (status in ('pending', 'answered', 'superseded')),
  created_at  timestamptz not null default now()
);
create unique index if not exists se_reporter_questions_one_pending_per_run
  on public.se_reporter_questions (run_id) where (status = 'pending');
create index if not exists se_reporter_questions_run_idx on public.se_reporter_questions (run_id, created_at desc);

alter table public.se_reporter_questions enable row level security;
create policy se_reporter_questions_admin on public.se_reporter_questions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Compare-and-set target: an answer is only accepted against the exact revision it was shown for, so a
-- stale/replayed client can never answer a question that has since been superseded. idempotency_key
-- makes a retried POST (e.g. a dropped response after the write succeeded) a no-op instead of a second
-- answer.
create table if not exists public.se_reporter_answers (
  id                 uuid primary key default gen_random_uuid(),
  question_id        uuid not null references public.se_reporter_questions(id) on delete cascade,
  run_id             uuid not null references public.se_runs(id) on delete cascade,
  answer             jsonb not null,   -- {optionId} or {text, requestChange}
  answered_revision  int not null,
  idempotency_key    text not null,
  created_at         timestamptz not null default now(),
  unique (question_id, idempotency_key)
);
create index if not exists se_reporter_answers_question_idx on public.se_reporter_answers (question_id);

alter table public.se_reporter_answers enable row level security;
create policy se_reporter_answers_admin on public.se_reporter_answers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Widen se_messages.role so a reporter's answer can be dropped into the same mailbox spec-refine.ts
-- already drains, labeled distinctly (role='reporter') so the prompt-builder can frame it as untrusted
-- product input rather than an admin instruction. Constraint name matches Postgres's default naming for
-- the inline `check (role in (...))` in migration 001.
alter table public.se_messages drop constraint if exists se_messages_role_check;
alter table public.se_messages add constraint se_messages_role_check
  check (role in ('admin', 'agent', 'system', 'reporter'));
