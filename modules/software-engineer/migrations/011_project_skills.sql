-- Per-project skills gate (§7.5a). By default the runner starts agent sessions with NO skills — it
-- sets settingSources:[] to avoid the repo's plugin marketplace, which can't fetch inside the runner
-- container. This column lets a project OPT IN to specific skills: each entry is a git repo + a plugin
-- sub-path the runner clones (with the project PAT) and loads as a LOCAL Claude plugin (skills/hooks)
-- into every agent session — no marketplace, no network fetch at session start.
--
-- Shape: jsonb array of { "repo": "owner/name", "path": "plugins/gatewaze-skills", "ref": "main" }.
-- Admin-only setting (same trust tier as the PAT), validated by lib/skills.ts#parseSkillsConfig and
-- the admin PUT allowlist before it is ever used. Default [] = no skills (behaviour unchanged).
alter table public.se_projects add column if not exists skills jsonb not null default '[]'::jsonb;

comment on column public.se_projects.skills is
  'Per-project skills: [{repo,path,ref}] git repos the runner loads as local Claude plugins into agent sessions. Admin-only; validated by lib/skills.ts. [] = none.';
