-- 011: blog posts as related-content candidates by topic.
--
-- Blog posts are already keyword-evaluated (the blog_post adapter + topic
-- rules), but their matches live in content_keyword_item_state, which client
-- roles can't read. This SECURITY DEFINER lookup exposes exactly the card
-- fields for PUBLISHED posts matching topic rules — nothing else. External
-- posts (is_external, e.g. the AAIF scraped blog) resolve to their canonical
-- URL so related cards link out to the real article.

create or replace function related_blog_posts_by_topics(
  p_topics text[],
  p_limit integer default 4
)
returns table (
  href text, title text, description text, image_url text, overlap integer
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'content_keyword_item_state') then
    return; -- content-keywords not installed: no topic-matched blogs
  end if;
  return query
  with topic_rules as (
    select r.id, r.metadata->>'topic_slug' as slug
    from public.content_keyword_rules r
    where r.is_active and r.metadata ? 'topic_slug'
      and r.metadata->>'topic_slug' = any(p_topics)
  )
  select
    case when p.is_external and coalesce(p.canonical_url, '') <> ''
         then p.canonical_url else '/blog/' || p.slug end as href,
    p.title,
    p.excerpt as description,
    p.featured_image as image_url,
    count(distinct tr.slug)::integer as overlap
  from public.content_keyword_item_state s
  join topic_rules tr on tr.id = any(s.matched_rule_ids)
  join public.blog_posts p on p.id = s.content_id
  where s.content_type = 'blog_post'
    and p.status = 'published'
  group by p.id, p.is_external, p.canonical_url, p.slug, p.title, p.excerpt, p.featured_image
  order by overlap desc, p.published_at desc nulls last
  limit greatest(1, least(p_limit, 10));
end $$;

revoke all on function related_blog_posts_by_topics(text[], integer) from public;
grant execute on function related_blog_posts_by_topics(text[], integer) to anon, authenticated, service_role;
