-- ============================================================================
-- Module: broadcasts
-- Migration: 030_duplicate_copies_segment
-- Description: duplicating a broadcast copied its segment_id, so the copy and
-- the original pointed at the SAME segment row. The Audience step edits that
-- row in place, so changing either broadcast's audience changed both.
--
-- A broadcast's segment belongs to that broadcast: the Audience step creates
-- it ("<broadcast> audience") and nothing else ever assigns one. So:
--
--   1. duplicate_broadcast now clones the segment for the copy, with its
--      memberships. The send fan-out reads segments_memberships, not the
--      definition, so a copy without them would have no recipients until
--      recalculated.
--   2. duplicate_broadcast now checks the caller is an admin (or the service
--      role) and is no longer executable by anon. It runs with the owner's
--      rights and had no check of its own.
--   3. Existing broadcasts that already share a segment are split: the
--      earliest-created one keeps the original row, every other one gets its
--      own clone, and its not-yet-fanned-out sends (draft / scheduled) are
--      repointed to the clone. Sends already sending or done keep the
--      original segment: their recipients were fixed at fan-out.
--
-- The clone keeps the current definition. Where both broadcasts were already
-- edited through the shared row, the original's earlier audience is not
-- recoverable; each can now be edited independently.
-- ============================================================================

-- Internal helper: copy a segment and its memberships. Not callable through
-- PostgREST (execute revoked below); SECURITY DEFINER callers run as owner.
CREATE OR REPLACE FUNCTION public.broadcasts_clone_segment(p_segment_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_new uuid;
BEGIN
  INSERT INTO public.segments (name, description, definition, type, status, account_id,
    created_by, cached_count, last_calculated_at, calculation_duration_ms,
    created_by_person_id, created_via)
  SELECT left(coalesce(p_name, s.name), 255), s.description, s.definition, s.type, s.status, s.account_id,
    s.created_by, s.cached_count, s.last_calculated_at, s.calculation_duration_ms,
    s.created_by_person_id, s.created_via
  FROM public.segments s WHERE s.id = p_segment_id
  RETURNING id INTO v_new;

  -- Missing source segment: nothing to clone; caller keeps what it had.
  IF v_new IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.segments_memberships (segment_id, person_id, joined_at, last_verified_at, added_by, source)
  SELECT v_new, m.person_id, m.joined_at, m.last_verified_at, m.added_by, m.source
  FROM public.segments_memberships m WHERE m.segment_id = p_segment_id;

  RETURN v_new;
END $fn$;

REVOKE ALL ON FUNCTION public.broadcasts_clone_segment(uuid, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.broadcasts_clone_segment(uuid, text) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.duplicate_broadcast(p_broadcast_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_new uuid; v_content jsonb; v_segment uuid; v_name text; v_clone uuid;
BEGIN
  -- Runs with the owner's rights, so check the caller here: it copies a
  -- broadcast past RLS and now writes segments too. Admin UI callers are
  -- signed-in admins; the service role is trusted.
  IF NOT public.is_admin() AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.broadcasts (name, brand, channel, audience_type, segment_id, list_ids,
    category_list_id, subject, preheader, from_address, from_name, reply_to, body_text,
    content_json, rendered_html, event_id, forward_replies_to, include_prospects, type,
    folder_id, created_by)
  SELECT name || ' (Copy)', brand, channel, audience_type, segment_id, list_ids,
    category_list_id, subject, preheader, from_address, from_name, reply_to, body_text,
    content_json, rendered_html, event_id, forward_replies_to, include_prospects, type,
    folder_id, created_by
  FROM public.broadcasts WHERE id = p_broadcast_id
  RETURNING id, content_json, segment_id, name INTO v_new, v_content, v_segment, v_name;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'broadcast % not found', p_broadcast_id;
  END IF;

  -- The copy gets its own audience segment, so editing one broadcast's
  -- audience no longer edits the other's.
  IF v_segment IS NOT NULL THEN
    v_clone := public.broadcasts_clone_segment(v_segment, v_name || ' audience');
    UPDATE public.broadcasts SET segment_id = v_clone WHERE id = v_new;
  END IF;

  -- copy the content blocks with an old->new id map
  DROP TABLE IF EXISTS _bmap;
  CREATE TEMP TABLE _bmap ON COMMIT DROP AS
    SELECT b.id AS old_id, gen_random_uuid() AS new_id
    FROM public.broadcast_blocks b WHERE b.broadcast_id = p_broadcast_id;

  INSERT INTO public.broadcast_blocks (id, broadcast_id, templates_block_def_id, block_type,
    owner_module, sort_order, tracking_slug, content)
  SELECT m.new_id, v_new, b.templates_block_def_id, b.block_type,
    b.owner_module, b.sort_order, b.tracking_slug, b.content
  FROM public.broadcast_blocks b JOIN _bmap m ON m.old_id = b.id;

  -- copy each block's bricks, re-parented to the new block ids
  INSERT INTO public.broadcast_bricks (block_id, templates_brick_def_id, brick_type, sort_order, content)
  SELECT m.new_id, br.templates_brick_def_id, br.brick_type, br.sort_order, br.content
  FROM public.broadcast_bricks br JOIN _bmap m ON m.old_id = br.block_id;

  -- remap content_json.block_ids to the new block ids, preserving order
  IF v_content ? 'block_ids' THEN
    UPDATE public.broadcasts SET content_json = jsonb_set(v_content, '{block_ids}', (
      SELECT COALESCE(jsonb_agg(COALESCE(m.new_id::text, elem) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements_text(v_content->'block_ids') WITH ORDINALITY AS e(elem, ord)
      LEFT JOIN _bmap m ON m.old_id::text = elem
    )) WHERE id = v_new;
  END IF;

  DROP TABLE IF EXISTS _bmap;
  RETURN v_new;
END $fn$;

-- It was executable by PUBLIC (so by anon) with no caller check.
REVOKE ALL ON FUNCTION public.duplicate_broadcast(uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.duplicate_broadcast(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.duplicate_broadcast(uuid) TO authenticated, service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- Split broadcasts that already share a segment (made by the old duplicate).
DO $$
DECLARE r record; v_clone uuid;
BEGIN
  FOR r IN
    SELECT b.id, b.name, b.segment_id
    FROM public.broadcasts b
    WHERE b.segment_id IS NOT NULL
      AND b.id <> (
        SELECT b2.id FROM public.broadcasts b2
        WHERE b2.segment_id = b.segment_id
        ORDER BY b2.created_at, b2.id
        LIMIT 1
      )
  LOOP
    v_clone := public.broadcasts_clone_segment(r.segment_id, r.name || ' audience');
    CONTINUE WHEN v_clone IS NULL;
    UPDATE public.broadcasts SET segment_id = v_clone WHERE id = r.id;
    UPDATE public.broadcast_sends SET segment_id = v_clone
    WHERE broadcast_id = r.id AND segment_id = r.segment_id AND status IN ('draft', 'scheduled');
    RAISE NOTICE 'broadcast % now has its own segment % (was shared %)', r.id, v_clone, r.segment_id;
  END LOOP;
END $$;
