-- ============================================================================
-- Module: segments
-- Migration: 020_suppression_lists
-- Description: suppression lists. An admin uploads a CSV of email addresses
-- or SHA-256 hashes under a name of their choosing; the browser hashes any
-- addresses before upload, so only hashes are stored and nothing records
-- where the list came from. Audiences then use the 'suppression_list'
-- condition ("Not On List" / "On List") like any other criterion, so the
-- builder shows the count and the people included.
--
-- Hash: hex SHA-256 of the UTF-8 bytes of lower(trim(email)).
--
-- A condition that names a list that no longer exists matches NOBODY, for
-- both operators. Deleting a list must never quietly widen an audience to
-- the people it was suppressing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.segments_suppression_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  entry_count  integer NOT NULL DEFAULT 0,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.segments_suppression_entries (
  list_id     uuid NOT NULL REFERENCES public.segments_suppression_lists (id) ON DELETE CASCADE,
  email_hash  text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (list_id, email_hash)
);

ALTER TABLE public.segments_suppression_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_suppression_entries ENABLE ROW LEVEL SECURITY;

-- Admins read both: the audience preview runs as the signed-in admin and has to
-- see the entries to apply the condition. Writes go through the RPCs below.
DROP POLICY IF EXISTS segments_suppression_lists_admin_read ON public.segments_suppression_lists;
CREATE POLICY segments_suppression_lists_admin_read ON public.segments_suppression_lists
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS segments_suppression_entries_admin_read ON public.segments_suppression_entries;
CREATE POLICY segments_suppression_entries_admin_read ON public.segments_suppression_entries
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

REVOKE ALL ON public.segments_suppression_lists, public.segments_suppression_entries FROM anon, authenticated;
GRANT SELECT ON public.segments_suppression_lists, public.segments_suppression_entries TO authenticated;
GRANT ALL ON public.segments_suppression_lists, public.segments_suppression_entries TO service_role;

-- ---- Admin RPCs -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.segments_suppression_create(p_name text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.segments_suppression_lists (name, created_by)
  VALUES (btrim(p_name), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Add up to 5,000 hashes per call. Invalid values are rejected as a whole call
-- so a bad upload is visible, not half-applied. Returns the list's new size.
CREATE OR REPLACE FUNCTION public.segments_suppression_add(p_list_id uuid, p_hashes text[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.segments_suppression_lists WHERE id = p_list_id) THEN
    RAISE EXCEPTION 'suppression list not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF coalesce(array_length(p_hashes, 1), 0) > 5000 THEN
    RAISE EXCEPTION 'at most 5000 hashes per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_hashes) h WHERE h IS NULL OR h !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'every value must be a lowercase hex SHA-256 hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.segments_suppression_entries (list_id, email_hash)
  SELECT DISTINCT p_list_id, h FROM unnest(p_hashes) h
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO v_count FROM public.segments_suppression_entries WHERE list_id = p_list_id;
  UPDATE public.segments_suppression_lists SET entry_count = v_count, updated_at = now() WHERE id = p_list_id;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.segments_suppression_rename(p_list_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.segments_suppression_lists SET name = btrim(p_name), updated_at = now() WHERE id = p_list_id;
END $$;

CREATE OR REPLACE FUNCTION public.segments_suppression_delete(p_list_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.segments_suppression_lists WHERE id = p_list_id;
END $$;

-- ---- Condition source -------------------------------------------------------

-- {type:'suppression_list', operator:'not_on_list'|'on_list', source_id:<list uuid>}
CREATE OR REPLACE FUNCTION public.segments_suppression_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op text := COALESCE(cond->>'operator', 'not_on_list');
  v_id uuid;
  v_exists text;
BEGIN
  BEGIN
    v_id := (cond->>'source_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'false';
  END;
  -- Fail closed: an unknown or deleted list matches nobody, whatever the operator.
  IF v_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.segments_suppression_lists WHERE id = v_id) THEN
    RETURN 'false';
  END IF;
  v_exists := format(
    'EXISTS (SELECT 1 FROM public.segments_suppression_entries se WHERE se.list_id = %L AND se.email_hash = encode(sha256(convert_to(lower(btrim(p.email)), ''UTF8'')), ''hex''))',
    v_id);
  RETURN CASE WHEN v_op = 'on_list' THEN v_exists ELSE 'NOT ' || v_exists END;
END $$;

CREATE OR REPLACE FUNCTION public.segments_suppression_vocab(p_search text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN NOT public.is_admin() THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(e) FROM (
      SELECT jsonb_build_object(
               'id', l.id::text,
               'label', l.name || ' (' || l.entry_count || ')',
               'extra', jsonb_build_object('entry_count', l.entry_count)
             ) AS e
      FROM public.segments_suppression_lists l
      WHERE p_search IS NULL OR l.name ILIKE '%' || p_search || '%'
      ORDER BY l.created_at DESC
      LIMIT p_limit
    ) x), '[]'::jsonb) END
$$;

INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES (
  'suppression_list', 'segments', 'Suppression list',
  'segments_suppression_to_sql', 'segments_suppression_vocab',
  jsonb_build_object(
    'type', 'object',
    'required', jsonb_build_array('source_id'),
    'properties', jsonb_build_object(
      'source_id', jsonb_build_object('type', 'string', 'x-entity-source', true)
    )
  ),
  ARRAY['not_on_list', 'on_list'],
  15
) ON CONFLICT (kind) DO UPDATE
  SET predicate_fn = EXCLUDED.predicate_fn, vocabulary_fn = EXCLUDED.vocabulary_fn,
      params_schema = EXCLUDED.params_schema, operators = EXCLUDED.operators,
      label = EXCLUDED.label, module_id = EXCLUDED.module_id;

REVOKE ALL ON FUNCTION public.segments_suppression_create(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_suppression_add(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_suppression_rename(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_suppression_delete(uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.segments_suppression_create(text) FROM anon;
  REVOKE ALL ON FUNCTION public.segments_suppression_add(uuid, text[]) FROM anon;
  REVOKE ALL ON FUNCTION public.segments_suppression_rename(uuid, text) FROM anon;
  REVOKE ALL ON FUNCTION public.segments_suppression_delete(uuid) FROM anon;
  REVOKE ALL ON FUNCTION public.segments_suppression_vocab(text, integer) FROM anon;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_create(text) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_add(uuid, text[]) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_rename(uuid, text) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_delete(uuid) TO authenticated, service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
