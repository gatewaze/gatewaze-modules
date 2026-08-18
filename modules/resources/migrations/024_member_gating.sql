-- ============================================================================
-- resources — opt-in member gating on sr_items reads
-- ============================================================================
-- Adds content_access_visible('resource', id, occurred_at::timestamptz) to the
-- anon + authenticated SELECT RLS. No-op until an admin sets a content_access
-- policy for content_type 'resource' (per-item or per-type, incl. embargo_days).
-- Admins keep full read via the SEPARATE sr_items_admin_preview policy (RLS
-- policies OR together), so the authenticated policy here doesn't need its own
-- is_admin() branch. content-platform is a declared dependency.
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
