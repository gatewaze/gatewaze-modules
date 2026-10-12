alter table public.se_repos add column if not exists merge_policy text not null default 'inherit' check (merge_policy in ('inherit','manual','auto_merge_verified'));
alter table public.se_runs add column if not exists merge_conflict_attempts integer not null default 0;
alter table public.se_run_prs add column if not exists verified_sha text;
