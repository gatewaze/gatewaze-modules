-- ============================================================================
-- resources — opt-in member gating on sr_items reads
-- ============================================================================
-- Adds content_access_visible('resource', id, occurred_at::timestamptz) to the
-- anon + authenticated SELECT RLS. No-op until an admin sets a content_access
-- policy for content_type 'resource' (per-item or per-type, incl. embargo_days).
-- Admins keep full read via the SEPARATE admin policy (sr_items_admin_all,
-- FOR ALL USING is_admin(), migration 001; plus sr_items_admin_preview from
-- 018) — RLS policies OR together, so the authenticated policy here doesn't
-- need its own is_admin() branch. content-platform is a declared dependency.
-- occurred_at is a date (nullable) — cast to timestamptz for the embargo leg;
-- a NULL occurred_at simply disables the embargo window for that item.
-- ============================================================================

DROP POLICY IF EXISTS "sr_items_anon_select" ON public.sr_items;
CREATE POLICY "sr_items_anon_select" ON public.sr_items
  FOR SELECT TO anon
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections c
      WHERE c.id = sr_items.collection_id
        AND c.status = 'published'
        AND c.access = ANY (ARRAY['public','metered'])
    )
    AND public.content_access_visible('resource', id, occurred_at::timestamptz)
  );

DROP POLICY IF EXISTS "sr_items_auth_select" ON public.sr_items;
CREATE POLICY "sr_items_auth_select" ON public.sr_items
  FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections c
      WHERE c.id = sr_items.collection_id
        AND c.status = 'published'
    )
    AND public.content_access_visible('resource', id, occurred_at::timestamptz)
  );

-- CRITICAL: resources also has SECURITY DEFINER anon read paths that BYPASS RLS
-- (an RPC + a view used by the public API), so the gate must be added to them
-- too. Bodies otherwise verbatim from 003_keyword_adapter.sql / 006_metered_access.sql.
CREATE OR REPLACE FUNCTION public.sr_items_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_collection_slug text DEFAULT NULL
) RETURNS SETOF public.sr_items
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.* FROM public.sr_items i
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='sr_item' AND s.content_id=i.id
  LEFT JOIN public.sr_collections c ON c.id = i.collection_id
  WHERE i.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='sr_item'),
                 true) = true
    AND (p_collection_slug IS NULL OR c.slug = p_collection_slug)
    AND public.content_access_visible('resource', i.id, i.occurred_at::timestamptz)
  ORDER BY i.sort_order, i.created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;
ALTER FUNCTION public.sr_items_public_list(int, int, text) OWNER TO gatewaze_module_writer;

-- sr_public_items is the feed/sitemap/public-API view. It is NOT SECURITY
-- DEFINER (runs as the querying role) but content_access_visible IS, so the
-- gate resolves correctly regardless of caller; anon / API-key callers have
-- auth.uid() NULL -> non-member -> gated items excluded.
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
  AND c.access = ANY (ARRAY['public'::text, 'metered'::text])
  AND public.content_access_visible('resource', i.id, i.occurred_at::timestamptz);
GRANT SELECT ON public.sr_public_items TO anon, authenticated, service_role;
