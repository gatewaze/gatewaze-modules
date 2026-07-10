-- 008: related_pins — curated topic -> content pinning for the related-content
-- resolver. High-value pairings (e.g. a voice-agents talk -> the voice-agents
-- buyer's/builder's guides) are editorial decisions, not inference: pins rank
-- above topic-containment matches in /api/related-content responses.
--
-- href-based rather than FK-based so pins can point at ANY surface (resource
-- items, chapter deep links, events, blog posts, external pages) without a
-- cross-module dependency graph.

create table if not exists public.related_pins (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  title       text not null,
  href        text not null,
  description text,
  image_url   text,
  card_type   text not null default 'resource',   -- display label: resource | event | blog | link
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint related_pins_topic_format
    check (topic ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  constraint related_pins_sort_order_nonneg
    check (sort_order >= 0),
  constraint related_pins_card_type_format
    check (card_type ~ '^[a-z][a-z0-9_-]{0,30}$')
);

drop trigger if exists related_pins_set_updated_at on public.related_pins;
create trigger related_pins_set_updated_at
  before update on public.related_pins
  for each row execute function public.set_updated_at();

create index if not exists related_pins_topic_idx
  on public.related_pins (topic, active, sort_order);

alter table public.related_pins enable row level security;

drop policy if exists related_pins_admin_all on public.related_pins;
create policy related_pins_admin_all on public.related_pins
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists related_pins_anon_select on public.related_pins;
create policy related_pins_anon_select on public.related_pins
  for select to anon using (active);

drop policy if exists related_pins_auth_select on public.related_pins;
create policy related_pins_auth_select on public.related_pins
  for select to authenticated using (active);
