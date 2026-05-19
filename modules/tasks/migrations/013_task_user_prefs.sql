-- tasks module — 013 — per-user notification prefs (spec §3.7).

create table if not exists public.task_user_prefs (
  admin_profile_id uuid primary key references admin_profiles(id) on delete cascade,
  in_app_enabled boolean not null default true,
  email_enabled boolean not null default true,
  email_cadence text not null default 'daily' check (email_cadence in ('off','immediate','daily','weekly')),
  notify_on_assignment boolean not null default true,
  notify_on_mention boolean not null default true,
  notify_on_due_soon boolean not null default true,
  notify_on_followed_change boolean not null default true,
  due_soon_lead_hours integer not null default 24,
  time_zone text,
  updated_at timestamptz not null default now()
);
