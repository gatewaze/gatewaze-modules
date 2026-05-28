-- gatewaze-fetch — domain governance rules (spec §11.2).

create table if not exists fetch.instance_domain_rules (
  id uuid primary key default gen_random_uuid(),
  list_kind text not null check (list_kind in ('allow', 'deny')),
  pattern text not null,
  reason text,
  created_by uuid references admin_profiles(id),
  created_at timestamptz not null default now(),
  unique (list_kind, pattern)
);

create table if not exists fetch.key_domain_rules (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  list_kind text not null check (list_kind in ('allow', 'deny')),
  pattern text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (api_key_id, list_kind, pattern)
);

create index if not exists idx_fetch_kdr_key
  on fetch.key_domain_rules (api_key_id);

-- Monotonic version counter — bumped by trigger on insert/update/delete.
-- Used as part of the idempotency cache key (§10.5) so rule changes
-- invalidate cached responses.
create table if not exists fetch.domain_rules_version (
  singleton boolean primary key default true check (singleton),
  version bigint not null default 1
);
insert into fetch.domain_rules_version default values
on conflict (singleton) do nothing;

create or replace function fetch.bump_domain_rules_version()
returns trigger language plpgsql as $$
begin
  update fetch.domain_rules_version
     set version = version + 1
   where singleton = true;
  return null;
end $$;

drop trigger if exists trg_fetch_instance_domain_rules_bump
  on fetch.instance_domain_rules;
create trigger trg_fetch_instance_domain_rules_bump
after insert or update or delete on fetch.instance_domain_rules
for each statement execute function fetch.bump_domain_rules_version();

drop trigger if exists trg_fetch_key_domain_rules_bump
  on fetch.key_domain_rules;
create trigger trg_fetch_key_domain_rules_bump
after insert or update or delete on fetch.key_domain_rules
for each statement execute function fetch.bump_domain_rules_version();

-- Seed the default instance denylist (§7.3). Idempotent via
-- ON CONFLICT (list_kind, pattern) DO NOTHING.
insert into fetch.instance_domain_rules (list_kind, pattern, reason) values
  ('deny', 'localhost',                  'default: loopback'),
  ('deny', '127.0.0.1',                  'default: loopback'),
  ('deny', '0.0.0.0',                    'default: any-IP'),
  ('deny', '*.local',                    'default: mDNS'),
  ('deny', '*.internal',                 'default: internal'),
  ('deny', '*.localhost',                'default: loopback'),
  ('deny', 'metadata.google.internal',   'default: GCE metadata'),
  ('deny', '169.254.169.254',            'default: AWS/Azure metadata IP'),
  ('deny', '[::1]',                      'default: IPv6 loopback')
on conflict (list_kind, pattern) do nothing;
