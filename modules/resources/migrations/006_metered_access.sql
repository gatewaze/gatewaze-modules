-- ============================================================================
-- structured-resources — 'metered' access tier (NYT-style flexible sampling).
--
-- A metered collection is SEO-gated: its full content is readable by anonymous
-- machine clients (search crawlers, the /md markdown endpoint, the public REST
-- API, and the MCP server all use the anon role), while the visual portal page
-- shows only a teaser + a sign-in gate to logged-out humans. The gate is a
-- conversion device, not a security boundary — the content is intentionally
-- open to agents so it keeps its SEO/discoverability value.
--
-- Contrast with 'authenticated', which stays a HARD gate: hidden from anon
-- (and therefore from crawlers/agents) entirely, for genuinely private content.
-- ============================================================================

-- 1. Allow 'metered' as an access value.
ALTER TABLE public.sr_collections DROP CONSTRAINT IF EXISTS sr_collections_access_check;
ALTER TABLE public.sr_collections ADD CONSTRAINT sr_collections_access_check
  CHECK (access = ANY (ARRAY['public'::text, 'authenticated'::text, 'inherit'::text, 'metered'::text]));

-- 2. Extend the anon SELECT policies so item/section/category bodies of a
--    metered collection are returned to the anon role (public OR metered).
--    This is the single change that makes crawlers, /md, feeds, the public API
--    and MCP serve full metered content — no code change needed on those
--    surfaces. Note: 'metered' must be set explicitly on the collection;
--    'inherit' does NOT resolve to metered here (RLS can't read module config).

DROP POLICY IF EXISTS sr_items_anon_select ON public.sr_items;
CREATE POLICY sr_items_anon_select ON public.sr_items
  FOR SELECT TO anon
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections c
      WHERE c.id = sr_items.collection_id
        AND c.status = 'published'
        AND c.access = ANY (ARRAY['public'::text, 'metered'::text])
    )
  );

DROP POLICY IF EXISTS sr_sections_anon_select ON public.sr_sections;
CREATE POLICY sr_sections_anon_select ON public.sr_sections
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM public.sr_items i
      JOIN public.sr_collections c ON c.id = i.collection_id
      WHERE i.id = sr_sections.item_id
        AND i.status = 'published'
        AND c.status = 'published'
        AND c.access = ANY (ARRAY['public'::text, 'metered'::text])
    )
  );

DROP POLICY IF EXISTS sr_categories_anon_select ON public.sr_categories;
CREATE POLICY sr_categories_anon_select ON public.sr_categories
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.sr_collections c
      WHERE c.id = sr_categories.collection_id
        AND c.status = 'published'
        AND c.access = ANY (ARRAY['public'::text, 'metered'::text])
    )
  );

-- 3. Surface metered items in the unified content projection (sr_public_items)
--    so they appear in /api/v1/content, feeds and the sitemap — i.e. so search
--    engines and agents discover the URLs. Full-text stays reachable via /md,
--    the item API and MCP; only the visual page is gated. (Redefinition mirrors
--    005_public_items_view.sql with 'metered' added to the access filter.)
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
  AND c.access = ANY (ARRAY['public'::text, 'metered'::text]);

GRANT SELECT ON public.sr_public_items TO anon, authenticated, service_role;
