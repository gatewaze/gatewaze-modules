-- ============================================================================
-- newsletters — opt-in member gating / embargo on whole editions
-- ============================================================================
-- Adds content_access_visible('newsletter_edition', id, edition_date::timestamptz)
-- to the editions SELECT RLS. Enables the "show the latest editions to members,
-- hide recent ones from everyone else" case: set a content_access policy for
-- content_type 'newsletter_edition' with embargo_days = N (e.g. 30) — editions
-- dated within the last N days become members-only; older editions stay public.
-- Or gate specific editions per-item. NO-OP until such a policy is set
-- (content_access_visible returns true with no policy). Admins keep full read.
-- content-platform is a declared dependency of newsletters.
--
-- (This gates the whole EDITION row — distinct from per-block gating in 079/081.)
-- ============================================================================

-- anon: published + from a public collection, AND (when gated) visible.
DROP POLICY IF EXISTS newsletters_editions_anon_select ON public.newsletters_editions;
CREATE POLICY newsletters_editions_anon_select ON public.newsletters_editions
  FOR SELECT TO anon
  USING (
    status = 'published'
    AND collection_id IN (
      SELECT id FROM public.newsletters_template_collections
      WHERE require_login IS NOT TRUE
    )
    AND public.content_access_visible('newsletter_edition', id, edition_date::timestamptz)
  );

-- authenticated: was USING(true); admins keep full read, others subject to the gate.
DROP POLICY IF EXISTS "newsletters_editions_select" ON public.newsletters_editions;
CREATE POLICY "newsletters_editions_select" ON public.newsletters_editions
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.content_access_visible('newsletter_edition', id, edition_date::timestamptz));

-- CRITICAL: newsletters also has a SECURITY DEFINER anon read RPC that BYPASSES
-- RLS, so the gate must be added there too (else embargoed/gated editions leak
-- via the anon key). Body otherwise verbatim from 017_keyword_adapter.sql.
CREATE OR REPLACE FUNCTION public.newsletters_public_list(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS SETOF public.newsletters_editions
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT n.* FROM public.newsletters_editions n
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='newsletter_edition' AND s.content_id=n.id
  WHERE n.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='newsletter_edition'),
                 true) = true
    AND public.content_access_visible('newsletter_edition', n.id, n.edition_date::timestamptz)
  ORDER BY n.edition_date DESC NULLS LAST, n.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;
ALTER FUNCTION public.newsletters_public_list(int, int) OWNER TO gatewaze_module_writer;

-- The generic /api/v1/content aggregator (packages/api reads each module's
-- publicContentSources.table via the SERVICE-ROLE client, bypassing RLS). Point
-- the newsletters source at a gated view so a gated/embargoed edition's METADATA
-- (title, preheader) doesn't leak via /api/v1/content?expand=full. Columns mirror
-- publicContentSources.fullFields + what the aggregator's summary/resourcePath need.
CREATE OR REPLACE VIEW public.newsletters_public_editions AS
SELECT id, collection_id, title, edition_date, preheader, content_category, status, created_at, updated_at
FROM public.newsletters_editions
WHERE status = 'published'
  AND public.content_access_visible('newsletter_edition', id, edition_date::timestamptz);
GRANT SELECT ON public.newsletters_public_editions TO anon, authenticated, service_role;
