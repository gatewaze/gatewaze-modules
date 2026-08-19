-- ============================================================================
-- newsletters — per-BLOCK member gating (web view + send), placeholder-based
-- ============================================================================
-- A single edition can mix public and members-only blocks. A gated block is
-- never removed; it is SUBSTITUTED with a small "members only" placeholder for
-- non-members — in the portal web view AND in the sent email.
--
-- Storage: an inline `access_policy jsonb` on the block row (NULL = public),
-- same SHAPE as a content_access_policies row so the whole platform speaks one
-- policy language:
--   { "audience": "members",           -- only 'members' gates; absent/other = public
--     "min_tier_rank": 0,              -- 0 = any member; else >= tier_rank
--     "placeholder": {                 -- optional; falls back to a default
--        "title": "...", "body": "...", "cta_label": "...", "cta_url": "..." } }
-- Inline (not the registry) because blocks are ephemeral children of an edition
-- and cascade-delete with it; they share the registry's SHAPE + the membership
-- primitives, which is what "unified" buys us.
--
-- Two enforcement seams:
--   * WEB VIEW  — base-table RLS hides gated block/brick ROWS from non-members
--     (defense in depth: a direct PostgREST read leaks nothing), and a
--     SECURITY DEFINER read `newsletters_blocks_for_viewer` returns the gated
--     rows REDACTED to a placeholder so the portal can render it in place.
--   * SEND      — handled in the send binding (per-recipient token → real HTML
--     or placeholder via membership_person_is_member); see send-engine-binding.
--
-- Membership is late-bound via to_regprocedure so newsletters keeps no hard
-- migration-order dependency on the membership module (absent => no teeth).
-- ============================================================================

ALTER TABLE public.newsletters_edition_blocks
  ADD COLUMN IF NOT EXISTS access_policy jsonb;

COMMENT ON COLUMN public.newsletters_edition_blocks.access_policy IS
  'Member-gating policy for this block (NULL = public). Shape matches content_access_policies: {audience, min_tier_rank, placeholder}.';

-- ----------------------------------------------------------------------------
-- newsletters_block_access_ok — may the CURRENT viewer see a block with this
-- access_policy? true when the block is public, or the viewer is a qualifying
-- member. Late-binds current_person_is_member(int). Used by RLS + the read RPC.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_block_access_ok(p_access_policy jsonb)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tier int;
BEGIN
  IF p_access_policy IS NULL
     OR COALESCE(p_access_policy->>'audience', 'public') <> 'members' THEN
    RETURN true;                                        -- public block
  END IF;
  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;                                        -- no membership system => no teeth
  END IF;
  v_tier := COALESCE(NULLIF(p_access_policy->>'min_tier_rank','')::int, 0);
  RETURN public.current_person_is_member(v_tier);
END $$;
ALTER FUNCTION public.newsletters_block_access_ok(jsonb) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.newsletters_block_access_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletters_block_access_ok(jsonb)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Tighten base-table RLS so gated block ROWS are invisible to non-members on a
-- direct read. Admins keep full read (the editor must see + edit gated blocks).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS newsletters_blocks_anon_select ON public.newsletters_edition_blocks;
CREATE POLICY newsletters_blocks_anon_select ON public.newsletters_edition_blocks
  FOR SELECT TO anon
  USING (public.newsletters_block_access_ok(access_policy));

DROP POLICY IF EXISTS "newsletters_edition_blocks_select" ON public.newsletters_edition_blocks;
CREATE POLICY "newsletters_edition_blocks_select" ON public.newsletters_edition_blocks
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.newsletters_block_access_ok(access_policy));

-- Bricks (sub-blocks) inherit their parent block's gate — otherwise gated
-- content leaks through the bricks table. (034 added anon read as USING(true).)
DROP POLICY IF EXISTS newsletters_bricks_anon_select ON public.newsletters_edition_bricks;
CREATE POLICY newsletters_bricks_anon_select ON public.newsletters_edition_bricks
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.newsletters_edition_blocks b
    WHERE b.id = newsletters_edition_bricks.block_id
      AND public.newsletters_block_access_ok(b.access_policy)
  ));

DROP POLICY IF EXISTS "newsletters_edition_bricks_select" ON public.newsletters_edition_bricks;
CREATE POLICY "newsletters_edition_bricks_select" ON public.newsletters_edition_bricks
  FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.newsletters_edition_blocks b
    WHERE b.id = newsletters_edition_bricks.block_id
      AND public.newsletters_block_access_ok(b.access_policy)
  ));

-- ----------------------------------------------------------------------------
-- newsletters_default_block_placeholder — the fallback placeholder payload used
-- when a gated block sets no custom one. Kept as a function so it is a single
-- source of truth for both the web-view RPC and (documentationally) the send path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_default_block_placeholder()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'title',     'Members only',
    'body',      'This section is available to AAIF member organizations. Sign in with your member email to read it.',
    'cta_label', 'About membership',
    'cta_url',   '/members'
  );
$$;
GRANT EXECUTE ON FUNCTION public.newsletters_default_block_placeholder()
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- newsletters_blocks_for_viewer — the portal's block read. Returns every block
-- of a PUBLISHED edition in order; a block the current viewer may not see comes
-- back REDACTED: content is nulled, its block-def link dropped, `gated`=true and
-- `placeholder` carries the copy to render in its place. SECURITY DEFINER so it
-- can evaluate every block and redact, rather than leaking or omitting silently.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_blocks_for_viewer(p_edition_id uuid)
RETURNS TABLE (
  id                     uuid,
  edition_id             uuid,
  block_type             varchar,
  sort_order             integer,
  templates_block_def_id uuid,
  content                jsonb,
  gated                  boolean,
  placeholder            jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    b.id,
    b.edition_id,
    b.block_type,
    COALESCE(b.sort_order, b.block_order) AS sort_order,
    CASE WHEN ok THEN b.templates_block_def_id ELSE NULL END           AS templates_block_def_id,
    CASE WHEN ok THEN b.content ELSE NULL END                          AS content,
    (NOT ok)                                                            AS gated,
    CASE WHEN ok THEN NULL
         ELSE COALESCE(b.access_policy->'placeholder',
                       public.newsletters_default_block_placeholder()) END AS placeholder
  FROM public.newsletters_edition_blocks b
  JOIN public.newsletters_editions e ON e.id = b.edition_id
  CROSS JOIN LATERAL (SELECT public.newsletters_block_access_ok(b.access_policy) AS ok) g
  WHERE b.edition_id = p_edition_id
    AND e.status = 'published'
    AND b.deleted_at IS NULL
  ORDER BY COALESCE(b.sort_order, b.block_order) NULLS LAST, b.created_at;
$$;
ALTER FUNCTION public.newsletters_blocks_for_viewer(uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.newsletters_blocks_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletters_blocks_for_viewer(uuid)
  TO anon, authenticated, service_role;
