-- 013: source-agnostic related content.
--
-- The resolver started life block-centric (a talk card was the only "thing
-- you're looking at"). These lookups let ANY embedded unit be the source —
-- blog post pages, event pages, resource items — without widening client
-- read access to the underlying tables:
--
--   related_topics_for(type, id)  -> the source's topic slugs (drives the
--                                    containment legs when the caller
--                                    doesn't pass topics explicitly)
--   related_source_meta(type, id) -> the source's canonical href + parent
--                                    item (self-exclusion seeds)

create or replace function related_topics_for(
  p_content_type text,
  p_content_id uuid
)
returns text[]
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  slugs text[] := '{}';
begin
  if p_content_type = 'sr_block' then
    select coalesce(array_agg(distinct t), '{}') into slugs
    from public.sr_blocks b, lateral (
      select jsonb_array_elements_text(coalesce(b.data->'topics', '[]'::jsonb)) as t
      union
      select jsonb_array_elements_text(coalesce(b.data->'topics_auto', '[]'::jsonb))
    ) topics
    where b.id = p_content_id;
  elsif p_content_type = 'sr_item' then
    select coalesce(array_agg(distinct t), '{}') into slugs
    from public.sr_blocks b, lateral (
      select jsonb_array_elements_text(coalesce(b.data->'topics', '[]'::jsonb)) as t
      union
      select jsonb_array_elements_text(coalesce(b.data->'topics_auto', '[]'::jsonb))
    ) topics
    where b.item_id = p_content_id;
  elsif p_content_type = 'event' then
    select coalesce(array_agg(distinct t), '{}') into slugs
    from public.events e, unnest(coalesce(e.event_topics, '{}')) as t
    where e.id = p_content_id;
  elsif p_content_type = 'blog_post' then
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'content_keyword_item_state') then
      select coalesce(array_agg(distinct r.metadata->>'topic_slug'), '{}') into slugs
      from public.content_keyword_item_state s
      join public.content_keyword_rules r on r.id = any(s.matched_rule_ids)
      where s.content_type = 'blog_post' and s.content_id = p_content_id
        and r.is_active and r.metadata ? 'topic_slug';
    end if;
  end if;
  -- only well-formed topic slugs leave this function
  return coalesce(array(
    select t from unnest(slugs) as t where t ~ '^[a-z0-9][a-z0-9-]{0,60}$'
  ), '{}');
end $$;

revoke all on function related_topics_for(text, uuid) from public;
grant execute on function related_topics_for(text, uuid) to anon, authenticated, service_role;

create or replace function related_source_meta(
  p_content_type text,
  p_content_id uuid
)
returns table (href text, item_id uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.href, e.item_id
  from public.related_embeddings e
  where e.content_type = p_content_type and e.content_id = p_content_id;
$$;

revoke all on function related_source_meta(text, uuid) from public;
grant execute on function related_source_meta(text, uuid) to anon, authenticated, service_role;
