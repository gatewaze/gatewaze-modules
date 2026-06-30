-- sr_public_items: a pre-joined, public-only projection of resource items for
-- the unified /api/v1/content endpoint. That endpoint queries a SINGLE table
-- per content source and builds links per-row, but a resource item's public URL
-- needs its collection's slug (a join) — hence this view.
--
-- The WHERE clause bakes the public-visibility rule in (published item in a
-- published, access='public' collection), so consumers need no extra filter and
-- the view can never expose gated content. content_category is exposed as NULL
-- because the unified endpoint always selects it (resources have no category).

CREATE OR REPLACE VIEW public.sr_public_items AS
SELECT
  i.id,
  i.title,
  i.subtitle,
  i.slug                AS item_slug,
  c.slug                AS collection_slug,
  c.name                AS collection_name,
  cat.name              AS category_name,
  i.featured_image_url,
  i.external_url,
  i.created_at,
  i.updated_at,
  NULL::text            AS content_category
FROM public.sr_items i
JOIN public.sr_collections c ON c.id = i.collection_id
LEFT JOIN public.sr_categories cat ON cat.id = i.category_id
WHERE i.status = 'published'
  AND c.status = 'published'
  AND c.access = 'public';

GRANT SELECT ON public.sr_public_items TO anon, authenticated, service_role;
