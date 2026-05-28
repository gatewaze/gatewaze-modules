-- ============================================================================
-- Module: blog
-- Migration: 007_webhook_topic
-- Description: Register blog_posts as a webhook topic and attach the shared
--              emit_mutation_event() trigger. Per
--              spec-api-cache-and-revalidation §4.2 and §4.4.
--
-- Note: blog_posts has no site_id column in v1 — posts are cross-tenant.
-- Subscriptions interested in blog updates register with host_kind='global';
-- the trigger emits host_id as the well-known global UUID
-- (00000000-0000-0000-0000-000000000000).
-- ============================================================================

INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'blog_posts',
  NULL,
  'blog',
  'blog:{slug}',
  ARRAY['slug'],
  'Blog post index + detail pages. Cross-tenant in v1; subscribed by host_kind=global subscriptions.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS blog_posts_mutation ON public.blog_posts;
CREATE TRIGGER blog_posts_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
