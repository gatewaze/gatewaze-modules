-- Architecture-review flow: commit-to-main + explicit approve gate (supersedes the PR-based gate).
--
-- The agent no longer opens a PR in the architecture repo. Instead it writes the proposal as a DRAFT
-- artifact (kind='architecture'); a human reviews it in the admin, chats with the agent to refine it
-- (each message re-runs a short refine job that rewrites the draft), then explicitly FINALIZES — which
-- commits the dated hyphenated folder straight to the arch repo's `main`, matching that repo's own
-- convention (no PR). The run then waits at `architecture_in_review` for the external architectural
-- review; the human can keep chatting (each change is re-committed to main) and finally APPROVES to
-- resume implementation. Two human gates (finalize, approve) with a chat loop around each.
--
-- 1) allow the 'architecture' artifact kind — the draft/committed proposal markdown, versioned by row.
alter table public.se_artifacts drop constraint if exists se_artifacts_kind_check;
alter table public.se_artifacts add constraint se_artifacts_kind_check
  check (kind in ('spec','review','diff','security_report','ci_report','pr','architecture'));

-- 2) allow the new 'architecture_in_review' run status (committed to main, awaiting the external review
--    and the human's approve-to-implement). 'awaiting_architecture' (the draft state) is added in 015;
--    re-asserted here so this migration is self-consistent on a fresh DB regardless of 015's presence.
alter table public.se_runs drop constraint if exists se_runs_status_check;
alter table public.se_runs add constraint se_runs_status_check
  check (status = any (array[
    'queued','running','blocked','failed','pr_open','watching','changes_requested','merged','closed','cancelled',
    'awaiting_architecture','architecture_in_review'
  ]));

-- 3) where the finalized proposal lives once committed to the arch repo's main (no PR): the dated
--    hyphenated folder, its README path within the repo, and the committed file URL to share with the
--    architecture team. The legacy architecture_pr_* columns (012) stay for back-compat but go unused.
alter table public.se_runs
  add column if not exists architecture_folder     text,
  add column if not exists architecture_path       text,
  add column if not exists architecture_commit_url text;

comment on column public.se_runs.architecture_folder is
  'Dated hyphenated proposal folder (YYYY-MM-Short-Name) committed to the architecture repo on finalize.';
comment on column public.se_runs.architecture_path is
  'Path of the proposal README within the architecture repo (architecture_folder + /README.md).';
comment on column public.se_runs.architecture_commit_url is
  'URL of the committed proposal README on the architecture repo''s main branch (shared with the architecture team).';

-- 4) tracker link template for PROJECTS whose issues live in a SEPARATE (often private) tracker/roadmap
--    repo while code PRs land on public repos (e.g. LFX: private danthebaker/lfx-roadmap issues → public
--    linuxfoundation/* PRs). pr.ts uses this to cite the real ticket by link in a cross-repo PR body,
--    instead of referencing the private issue/repo. `{key}` is replaced by the ticket key parsed from the
--    issue title, e.g. 'https://linuxfoundation.atlassian.net/browse/{key}'. Null = no tracker link.
alter table public.se_projects
  add column if not exists tracker_url_template text;

comment on column public.se_projects.tracker_url_template is
  'URL template with a {key} placeholder for linking the external tracking ticket (e.g. Jira) in cross-repo PR bodies; null = none.';
