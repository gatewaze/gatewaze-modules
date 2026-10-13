-- The spec worker has always stored the agent's closing message as a 'spec_summary' artifact, and
-- now stores the duplicate/codebase preflight as 'spec_preflight'. Neither kind was ever in this
-- check, so the summary insert failed silently and the preflight insert failed every spec run
-- whose preflight was valid ("Could not retain mandatory preflight evidence").
alter table public.se_artifacts drop constraint if exists se_artifacts_kind_check;
alter table public.se_artifacts add constraint se_artifacts_kind_check
 check (kind in ('spec','spec_summary','spec_preflight','review','diff','security_report','ci_report','pr','architecture','workspace_base'));
