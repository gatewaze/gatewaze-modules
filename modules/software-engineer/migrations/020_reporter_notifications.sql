-- Issue reporter provenance + gate-event notifications (§7, §8 of the phase-gates spec).
--
-- Reporter provenance: record who reported the triggering issue and from where, so a gate event can
-- notify them later. Captured at intake. Notifications: an optional per-project Slack webhook; when set,
-- the module posts a message on the key gate events (parked for review, submitted, merged). Off by
-- default (no webhook = no posts).

-- 1) reporter provenance on the run.
alter table public.se_runs
  add column if not exists reporter_source       text check (reporter_source in ('gatewaze','github')),
  add column if not exists reporter_identity      text,
  add column if not exists reporter_user_id       uuid,
  add column if not exists reporter_display_name  text;

comment on column public.se_runs.reporter_source is
  'Where the triggering issue was reported: gatewaze (in-app) or github. Captured at intake.';
comment on column public.se_runs.reporter_user_id is
  'The matched gatewaze user id for the reporter (via the identity map), else null.';

-- 2) per-project Slack webhook for gate-event notifications. Sealed like the other credentials, since a
--    webhook URL is a posting secret. Null = notifications off for the project.
alter table public.se_projects
  add column if not exists slack_webhook_ciphertext text,
  add column if not exists slack_webhook_last4      text;

comment on column public.se_projects.slack_webhook_ciphertext is
  'Encrypted Slack incoming-webhook URL; when set, gate events post to that channel. Null = off.';
