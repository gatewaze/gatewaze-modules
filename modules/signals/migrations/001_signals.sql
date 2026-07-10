-- signals module — 001: core schema.
--
-- Signals is the routing engine from the Gatewaze Signals proposal: every
-- (person, content) pair a rule matches becomes a FIRE routed to a channel,
-- every fire's downstream behavior becomes an OUTCOME, and outcomes are the
-- training data for later rule tuning. v1 ships the four moving parts:
-- profile reads (person_topic_interests), content reads (topics/embeddings
-- built in the resources layers), scoring + triggering (signals_rules ->
-- signals_fires), and the routing dispatcher (lib/engine.js channels:
-- log | webhook | portal_pin | broadcast_draft).
--
-- The module OWNS no identity, no content store and no send pipeline — it
-- reads the platform's and routes decisions to it.

-- ── Interests: what the platform knows a person cares about ─────────────────
-- Explicit rows (written by onboarding, imports, admin) merge with behavior
-- derived from event registrations in the person_topic_interests view.
create table if not exists public.signals_interests (
  person_id  uuid not null references public.people(id) on delete cascade,
  topic      text not null check (topic ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  weight     real not null default 1.0 check (weight > 0 and weight <= 10),
  source     text not null default 'explicit' check (source ~ '^[a-z][a-z0-9_-]{0,40}$'),
  created_at timestamptz not null default now(),
  primary key (person_id, topic, source)
);
create index if not exists signals_interests_topic_idx on public.signals_interests (topic);

-- Behavioral + explicit interest projection. Registrations inherit the
-- event's topics (checked-in attendance weighs more than a no-show RSVP).
create or replace view public.person_topic_interests as
select person_id, topic, sum(weight)::real as weight
from (
  select r.person_id,
         t.topic,
         case when r.checked_in then 1.5 else 1.0 end as weight
  from public.events_registrations r
  join public.events e on e.id = r.event_id
  cross join lateral unnest(coalesce(e.event_topics, '{}')) as t(topic)
  where r.person_id is not null
    and coalesce(r.status, '') not in ('cancelled')
    and t.topic ~ '^[a-z0-9][a-z0-9-]{0,60}$'
  union all
  select person_id, topic, weight from public.signals_interests
) merged
group by person_id, topic;

-- ── Rules ────────────────────────────────────────────────────────────────────
-- definition jsonb (validated by the write layer):
-- {
--   "topics": ["voice-agents"],            -- content + audience matching
--   "min_overlap": 1,                       -- topics a person must share
--   "min_weight": 1.0,                      -- summed interest weight floor
--   "content": { "types": ["sr_item","event"], "hrefs": [] },
--   "audience": { "segment_id": null, "per_person": true, "max": 200 },
--   "channel":  { "type": "log|webhook|portal_pin|broadcast_draft", "config": {} },
--   "frequency_cap": { "per_person_days": 30 },
--   "interval_minutes": 1440
-- }
create table if not exists public.signals_rules (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 120),
  description       text,
  status            text not null default 'paused' check (status in ('active', 'paused')),
  definition        jsonb not null default '{}'::jsonb,
  created_by        text,
  version           integer not null default 1,
  last_evaluated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists signals_rules_name_key on public.signals_rules (name);

-- ── Fires: one routing decision, dispatched to a channel ────────────────────
create table if not exists public.signals_fires (
  id            uuid primary key default gen_random_uuid(),
  rule_id       uuid not null references public.signals_rules(id) on delete cascade,
  person_id     uuid references public.people(id) on delete cascade,
  content_type  text not null,
  content_href  text not null,
  content_title text not null,
  channel       text not null,
  score         real not null default 0,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'fired'
                check (status in ('fired', 'dispatched', 'failed', 'suppressed')),
  error         text,
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz
);
-- dedupe: a rule routes a given content to a given person at most once
-- (person-independent fires use the zero uuid in the key)
create unique index if not exists signals_fires_dedupe_key
  on public.signals_fires (rule_id, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid), content_href);
create index if not exists signals_fires_rule_idx on public.signals_fires (rule_id, created_at desc);
create index if not exists signals_fires_person_idx on public.signals_fires (person_id, channel, created_at desc);

-- ── Outcomes: what happened after a fire ─────────────────────────────────────
create table if not exists public.signals_outcomes (
  id          uuid primary key default gen_random_uuid(),
  fire_id     uuid not null references public.signals_fires(id) on delete cascade,
  kind        text not null check (kind in ('click', 'view', 'register', 'purchase', 'reply', 'unsubscribe')),
  source      text not null default 'tracking',
  occurred_at timestamptz not null default now()
);
create index if not exists signals_outcomes_fire_idx on public.signals_outcomes (fire_id);

-- Public-callable outcome recorder: the portal tracking relay attributes
-- clicks on gw_sig-tagged hrefs back to their fire. SECURITY DEFINER with a
-- narrow contract (fire must exist, kind whitelisted by the table CHECK);
-- worst case an attacker records noise outcomes for a fire id they saw.
create or replace function signals_record_outcome(p_fire_id uuid, p_kind text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.signals_fires f where f.id = p_fire_id) then
    return; -- unknown fire: swallow, never error the tracking path
  end if;
  insert into public.signals_outcomes (fire_id, kind) values (p_fire_id, p_kind);
exception when others then
  return; -- outcome recording must never break the caller
end $$;
revoke all on function signals_record_outcome(uuid, text) from public;
grant execute on function signals_record_outcome(uuid, text) to anon, authenticated, service_role;

-- ── Telemetry ────────────────────────────────────────────────────────────────
create or replace view public.signals_rule_stats as
select
  r.id as rule_id,
  r.name,
  r.status,
  count(f.id) as fires,
  count(f.id) filter (where f.status = 'dispatched') as dispatched,
  count(f.id) filter (where f.status = 'failed') as failed,
  count(f.id) filter (where f.status = 'suppressed') as suppressed,
  count(o.id) as outcomes,
  count(o.id) filter (where o.kind = 'click') as clicks,
  max(f.created_at) as last_fire_at,
  r.last_evaluated_at
from public.signals_rules r
left join public.signals_fires f on f.rule_id = r.id
left join public.signals_outcomes o on o.fire_id = f.id
group by r.id;

-- ── RLS: admins manage, service role runs the engine, anon sees nothing ─────
alter table public.signals_rules enable row level security;
alter table public.signals_fires enable row level security;
alter table public.signals_outcomes enable row level security;
alter table public.signals_interests enable row level security;

do $policies$
declare t text;
begin
  foreach t in array array['signals_rules', 'signals_fires', 'signals_outcomes', 'signals_interests'] loop
    execute format('drop policy if exists %I_admin_all on public.%I', t, t);
    execute format(
      'create policy %I_admin_all on public.%I for all to authenticated using (is_admin()) with check (is_admin())',
      t, t);
  end loop;
end $policies$;
