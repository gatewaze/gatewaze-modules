-- ============================================================================
-- Module: signals
-- Migration: 005_content_ranking
-- Spec: spec-plays-audience-intelligence.md §4.8 (personalization / content ranking)
-- Description: Topic-affinity aggregation used to pick the content a given
--   audience (or person) cares about most.
--   topic_affinity_for_people() — summed, source-weighted+decayed affinity per
--     topic across a set of people. The draft-from-recap worker calls this over
--     the target audience to rank recap talks by aggregate relevance; the same
--     shape (single-element array) serves per-recipient ranking at send time.
--   Reads the governed person_topic_interests view, so ranking honours enabled
--   knowledge sources + lawful basis automatically.
--   Idempotent.
-- ============================================================================

create or replace function public.topic_affinity_for_people(p_person_ids uuid[])
returns table(topic text, weight real)
language sql stable security definer as $$
  select pti.topic, sum(pti.weight)::real as weight
  from public.person_topic_interests pti
  where pti.person_id = any(p_person_ids)
  group by pti.topic
$$;
grant execute on function public.topic_affinity_for_people(uuid[]) to authenticated, anon;
