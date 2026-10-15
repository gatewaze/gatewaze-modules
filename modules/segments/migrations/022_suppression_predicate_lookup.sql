-- ============================================================================
-- Module: segments
-- Migration: 022_suppression_predicate_lookup
-- Description: make the suppression_list predicate (020) fast whatever the
-- planner estimates.
--
-- 020 compiled to a correlated NOT EXISTS. When other conditions made the
-- planner expect very few people, it chose a nested loop that computed the
-- SHA-256 of each person's email once per list entry: ~180 million hashes on
-- AAIF, and a count that never finished. An uncorrelated NOT IN fixed counts
-- but was rescanned for every person under the preview's ORDER BY ... LIMIT.
--
-- The predicate now calls segments_suppression_has(), a plpgsql function the
-- planner cannot inline: one SHA-256 and one primary-key lookup per person.
-- A person with no email gets NULL, so they match neither operator. The
-- unknown-list rule from 020 is unchanged: it matches nobody.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_suppression_has(p_list_id uuid, p_email text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
COST 50
AS $$
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN NULL;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.segments_suppression_entries
     WHERE list_id = p_list_id
       AND email_hash = encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.segments_suppression_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op text := COALESCE(cond->>'operator', 'not_on_list');
  v_id uuid;
BEGIN
  BEGIN
    v_id := (cond->>'source_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'false';
  END;
  IF v_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.segments_suppression_lists WHERE id = v_id) THEN
    RETURN 'false';
  END IF;
  RETURN CASE WHEN v_op = 'on_list' THEN '' ELSE 'NOT ' END
    || format('public.segments_suppression_has(%L::uuid, p.email)', v_id);
END $$;

-- Only the definer-owned callers of the compiled SQL need the lookup. Granting
-- it to authenticated would let any signed-in user test whether an address
-- is on a list.
REVOKE ALL ON FUNCTION public.segments_suppression_has(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_suppression_to_sql(jsonb) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.segments_suppression_has(uuid, text) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_has(uuid, text) TO service_role;
  REVOKE ALL ON FUNCTION public.segments_suppression_to_sql(jsonb) FROM anon;
  GRANT EXECUTE ON FUNCTION public.segments_suppression_to_sql(jsonb) TO authenticated, service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
