-- ============================================================================
-- Module: broadcasts
-- Migration: 026_broadcast_folders
-- Description: Organisational folders for broadcasts + a first-class duplicate.
--   * broadcast_folders — a nested (parent_id) folder tree, brand-scoped.
--   * broadcasts.folder_id — which folder a broadcast lives in (null = unfiled).
--   * duplicate_broadcast(id) — atomic copy of a broadcast's content: the
--     broadcasts row (name suffixed "(Copy)"), its broadcast_blocks and
--     broadcast_bricks (re-parented, content_json.block_ids remapped), keeping
--     the source folder. It creates NO broadcast_sends, so the copy is a fresh
--     draft with no send state or metrics — mirroring how a newsletter edition
--     duplicates.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.broadcast_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES public.broadcast_folders(id) ON DELETE SET NULL,
  brand       text NOT NULL DEFAULT 'default',
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broadcast_folders_parent_idx ON public.broadcast_folders(parent_id);

ALTER TABLE public.broadcast_folders ENABLE ROW LEVEL SECURITY;
DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='broadcast_folders' AND policyname='auth_all_broadcast_folders') THEN
    -- mirrors broadcasts' own policy (auth_all_broadcasts): the admin app is the
    -- only authenticated caller and is route-gated to admins.
    CREATE POLICY "auth_all_broadcast_folders" ON public.broadcast_folders
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $pol$;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.broadcast_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS broadcasts_folder_idx ON public.broadcasts(folder_id);

CREATE OR REPLACE FUNCTION public.duplicate_broadcast(p_broadcast_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_new uuid; v_content jsonb;
BEGIN
  INSERT INTO public.broadcasts (name, brand, channel, audience_type, segment_id, list_ids,
    category_list_id, subject, preheader, from_address, from_name, reply_to, body_text,
    content_json, rendered_html, event_id, forward_replies_to, include_prospects, type,
    folder_id, created_by)
  SELECT name || ' (Copy)', brand, channel, audience_type, segment_id, list_ids,
    category_list_id, subject, preheader, from_address, from_name, reply_to, body_text,
    content_json, rendered_html, event_id, forward_replies_to, include_prospects, type,
    folder_id, created_by
  FROM public.broadcasts WHERE id = p_broadcast_id
  RETURNING id, content_json INTO v_new, v_content;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'broadcast % not found', p_broadcast_id;
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
