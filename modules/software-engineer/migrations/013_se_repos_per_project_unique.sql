-- Allow a repo to be a READ-ONLY reference in one project while it is a writable code repo in another
-- (§7.6a). Cross-project feature reference: e.g. the LFX project references gatewaze/gatewaze +
-- gatewaze-modules read-only so its runs can see how a feature was built, while those same repos stay
-- the Gatewaze project's writable code repos.
--
-- The old constraint was UNIQUE (repo_owner, repo_name) — GLOBAL, so a repo could belong to exactly
-- one project. Nothing resolves a project FROM a code repo (every se_repos lookup is by project_id),
-- so relaxing it to per-project is safe. Idempotent (drop-if-exists then add), and matches the change
-- already applied out-of-band on the aaif-staging DB.
alter table public.se_repos drop constraint if exists se_repos_owner_name_unique;
alter table public.se_repos drop constraint if exists se_repos_project_owner_name_unique;
alter table public.se_repos add constraint se_repos_project_owner_name_unique
  unique (project_id, repo_owner, repo_name);

-- ...but a repo may still be WRITABLE (an edit target) in at most ONE project — only read-only
-- references may be shared across projects. This partial unique index preserves that invariant, so
-- relaxing the constraint above can't accidentally let two projects (with different tokens) cut
-- branches / push to the same repo concurrently.
create unique index if not exists se_repos_one_writable_owner
  on public.se_repos (repo_owner, repo_name) where write_mode = 'writable';
