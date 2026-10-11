-- Keep the exact tested HELF source as a per-run artifact across spec/review/implementation.
alter table public.se_artifacts drop constraint if exists se_artifacts_kind_check;
alter table public.se_artifacts add constraint se_artifacts_kind_check
 check (kind in ('spec','review','diff','security_report','ci_report','pr','architecture','workspace_base'));
create unique index if not exists se_artifacts_workspace_base_unique
 on public.se_artifacts(run_id) where kind='workspace_base';

alter table public.se_repos add column if not exists preview_ref text;
