-- ============================================================================
-- Module: lists
-- Migration: 002_migrate_from_email_subscriptions
-- Description: Migrate existing email_topic_labels and email_subscriptions
--              data into the new lists tables. Idempotent.
-- ============================================================================

-- Migrate email_topic_labels → lists (if the source table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'email_topic_labels') THEN
    -- Check if source table has default_subscribed column
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_topic_labels' AND column_name = 'default_subscribed'
    ) THEN
      INSERT INTO public.lists (slug, name, description, is_active, default_subscribed)
      SELECT
        topic_id,
        label,
        description,
        COALESCE(is_active, true),
        COALESCE(default_subscribed, false)
      FROM public.email_topic_labels
      ON CONFLICT (slug) DO NOTHING;
    ELSE
      INSERT INTO public.lists (slug, name, description, is_active)
      SELECT
        topic_id,
        label,
        description,
        COALESCE(is_active, true)
      FROM public.email_topic_labels
      ON CONFLICT (slug) DO NOTHING;
    END IF;
  END IF;
END
$$;

-- Migrate email_subscriptions → list_subscriptions (if the source table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'email_subscriptions') THEN
    INSERT INTO public.list_subscriptions (list_id, email, person_id, subscribed, subscribed_at, unsubscribed_at, source)
    SELECT
      l.id,
      es.email,
      p.id,
      es.subscribed,
      es.subscribed_at,
      es.unsubscribed_at,
      COALESCE(es.source, 'import')
    FROM public.email_subscriptions es
    JOIN public.lists l ON l.slug = es.list_id
    LEFT JOIN public.people p ON LOWER(p.email) = LOWER(es.email)
    ON CONFLICT (list_id, email) DO NOTHING;
  END IF;
END
$$;
