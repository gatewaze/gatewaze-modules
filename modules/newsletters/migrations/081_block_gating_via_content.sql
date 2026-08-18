-- ============================================================================
-- newsletters — drive per-block gating from content->'_gate_*' (editor-native)
-- ============================================================================
-- 079 stored the gate in a dedicated access_policy column. The Puck editor's
-- save path sweeps every field value into the block's `content` jsonb and
-- writes a FIXED column list (newsletters_save_edition / _newsletters_apply_blocks),
-- so getting a value into a separate column would need coordinated edits across
-- the editor save path, the adapter, and two secondary block-copy writers —
-- high risk of breaking newsletter editing, and untestable without a browser.
--
-- Instead the gate lives in `content` under namespaced keys the editor writes
-- through its normal path (no hoist, and the saved state round-trips back into
-- the toggle for free because the adapter already reloads `content` into props):
--   content._gate_audience : 'public' | 'members'   (absent/other => public)
--   content._gate_tier     : min tier_rank (int, default 0 = any member)
--   content._gate_placeholder : optional {title,body,cta_label,cta_url} override
--
-- This migration repoints newsletters_block_access_ok + the RLS policies + the
-- read RPC to read from content, and drops the now-unused access_policy column.
-- The declarative renderer ignores the extra _gate_* keys; gated blocks have
-- their whole content nulled by the RPC before it ever reaches a non-member.
-- ============================================================================

-- Redefine the predicate to interpret its jsonb arg as the block's CONTENT
-- (was: a policy jsonb). The param KEEPS its 079 name (p_access_policy) because
-- CREATE OR REPLACE cannot rename a parameter; semantically it is now `content`.
CREATE OR REPLACE FUNCTION public.newsletters_block_access_ok(p_access_policy jsonb)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_content jsonb := p_access_policy;   -- arg is the block content now
  v_tier int;
BEGIN
  IF v_content IS NULL
     OR COALESCE(v_content->>'_gate_audience', 'public') <> 'members' THEN
    RETURN true;                                        -- public block
  END IF;
  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;                                        -- no membership system => no teeth
  END IF;
  v_tier := COALESCE(NULLIF(v_content->>'_gate_tier','')::int, 0);
  RETURN public.current_person_is_member(v_tier);
END $$;
ALTER FUNCTION public.newsletters_block_access_ok(jsonb) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.newsletters_block_access_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletters_block_access_ok(jsonb)
  TO anon, authenticated, service_role;

-- Recreate the RLS policies to pass `content` (same policy names as 079/001/013).
DROP POLICY IF EXISTS newsletters_blocks_anon_select ON public.newsletters_edition_blocks;
CREATE POLICY newsletters_blocks_anon_select ON public.newsletters_edition_blocks
  FOR SELECT TO anon
  USING (public.newsletters_block_access_ok(content));

DROP POLICY IF EXISTS "newsletters_edition_blocks_select" ON public.newsletters_edition_blocks;
CREATE POLICY "newsletters_edition_blocks_select" ON public.newsletters_edition_blocks
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.newsletters_block_access_ok(content));

DROP POLICY IF EXISTS newsletters_bricks_anon_select ON public.newsletters_edition_bricks;
CREATE POLICY newsletters_bricks_anon_select ON public.newsletters_edition_bricks
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.newsletters_edition_blocks b
    WHERE b.id = newsletters_edition_bricks.block_id
      AND public.newsletters_block_access_ok(b.content)
  ));

DROP POLICY IF EXISTS "newsletters_edition_bricks_select" ON public.newsletters_edition_bricks;
CREATE POLICY "newsletters_edition_bricks_select" ON public.newsletters_edition_bricks
  FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.newsletters_edition_blocks b
    WHERE b.id = newsletters_edition_bricks.block_id
      AND public.newsletters_block_access_ok(b.content)
  ));

-- Recreate the portal read RPC to gate + source the placeholder from content.
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
    CASE WHEN ok THEN b.templates_block_def_id ELSE NULL END AS templates_block_def_id,
    CASE WHEN ok THEN b.content ELSE NULL END               AS content,
    (NOT ok)                                                 AS gated,
    CASE WHEN ok THEN NULL
         ELSE COALESCE(b.content->'_gate_placeholder',
                       public.newsletters_default_block_placeholder()) END AS placeholder
  FROM public.newsletters_edition_blocks b
  JOIN public.newsletters_editions e ON e.id = b.edition_id
  CROSS JOIN LATERAL (SELECT public.newsletters_block_access_ok(b.content) AS ok) g
  WHERE b.edition_id = p_edition_id
    AND e.status = 'published'
    AND b.deleted_at IS NULL
  ORDER BY COALESCE(b.sort_order, b.block_order) NULLS LAST, b.created_at;
$$;
ALTER FUNCTION public.newsletters_blocks_for_viewer(uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.newsletters_blocks_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.newsletters_blocks_for_viewer(uuid)
  TO anon, authenticated, service_role;

-- The dedicated column is now unused (gating lives in content). No block has
-- set it yet (gating shipped in the same batch), so dropping loses no data.
ALTER TABLE public.newsletters_edition_blocks DROP COLUMN IF EXISTS access_policy;
