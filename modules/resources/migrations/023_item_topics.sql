-- ============================================================================
-- Module: resources
-- Migration: 023_item_topics
-- Spec: spec-plays-audience-intelligence.md §4.8 (topic-tagged content)
-- Description: Item-level topics on resource items, so a whole resource (not
--   just its individual talk blocks) can participate in topic-affinity ranking
--   and interest targeting — same `topics text[]` convention as sr_blocks.
--   Backfilled from the distinct topics of the item's talk/video blocks
--   (curated `topics` + keyword-derived `topics_auto`). GIN-indexed for
--   containment queries. Idempotent.
-- ============================================================================

alter table public.sr_items add column if not exists topics text[] not null default '{}';

create index if not exists sr_items_topics_gin on public.sr_items using gin (topics);

-- Backfill: union of every talk/video block's topics + topics_auto for the item.
update public.sr_items i
set topics = sub.topics
from (
  select b.item_id,
         array(
           select distinct t
           from public.sr_blocks bb
           cross join lateral (
             select jsonb_array_elements_text(coalesce(bb.data->'topics', '[]'::jsonb)) as t
             union
             select jsonb_array_elements_text(coalesce(bb.data->'topics_auto', '[]'::jsonb)) as t
           ) x
           where bb.item_id = b.item_id
             and bb.kind in ('talk', 'video')
             and t is not null and t <> ''
         ) as topics
  from public.sr_blocks b
  where b.kind in ('talk', 'video')
  group by b.item_id
) sub
where i.id = sub.item_id
  and (i.topics is null or i.topics = '{}')
  and array_length(sub.topics, 1) is not null;
