-- 014: teach the source-agnostic related resolver about `video`.
-- Re-creates related_topics_for (013) with a `video` branch: topic slugs come
-- from the content-keywords match state (like blog_post) unioned with any
-- explicit `videos.topics`. Guarded — no-ops on the video legs if the videos
-- table / keyword state isn't present.

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
  elsif p_content_type = 'video' then
    if to_regclass('public.videos') is not null then
      -- explicit topics on the video row
      select coalesce(array_agg(distinct t), '{}') into slugs
      from public.videos v, unnest(coalesce(v.topics, '{}')) as t
      where v.id = p_content_id;
      -- union content-keywords matched topic slugs
      if exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'content_keyword_item_state') then
        select coalesce(array_agg(distinct x), '{}') into slugs
        from (
          select unnest(slugs) as x
          union
          select r.metadata->>'topic_slug'
          from public.content_keyword_item_state s
          join public.content_keyword_rules r on r.id = any(s.matched_rule_ids)
          where s.content_type = 'video' and s.content_id = p_content_id
            and r.is_active and r.metadata ? 'topic_slug'
        ) u
        where x is not null;
      end if;
    end if;
  end if;
  -- only well-formed topic slugs leave this function
  return coalesce(array(
    select t from unnest(slugs) as t where t ~ '^[a-z0-9][a-z0-9-]{0,60}$'
  ), '{}');
end $$;

revoke all on function related_topics_for(text, uuid) from public;
grant execute on function related_topics_for(text, uuid) to anon, authenticated, service_role;
