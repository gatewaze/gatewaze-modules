-- ============================================================================
-- content_access: allow targeting an EXACT SET of tiers, not just a minimum.
-- ============================================================================
-- min_tier_rank answers "rank >= min". Editors also want "these specific tiers"
-- (e.g. gold+silver but not platinum, or foundation only). Add allowed_tiers
-- text[] (tier NAMES from membership_tier_ranks.tier). Semantics:
--   allowed_tiers non-empty  -> member must be in one of those tiers
--   allowed_tiers null/empty -> fall back to the min_tier_rank threshold
-- Enforcement late-binds the tier-set membership predicates (migration 025) the
-- same way it late-binds current_person_is_member, so content-platform keeps no
-- hard dependency on the membership module.
-- ============================================================================

ALTER TABLE public.content_access_policies
  ADD COLUMN IF NOT EXISTS allowed_tiers text[];

-- Recompile effective_policy against the widened row type (SELECT * now carries
-- allowed_tiers to the enforcement helpers).
CREATE OR REPLACE FUNCTION public.content_access_effective_policy(
  p_content_type text,
  p_entity_id    uuid
) RETURNS public.content_access_policies
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT *
  FROM public.content_access_policies
  WHERE content_type = p_content_type
    AND (entity_id = p_entity_id OR entity_id IS NULL)
  ORDER BY (entity_id IS NOT NULL) DESC
  LIMIT 1;
$$;
ALTER FUNCTION public.content_access_effective_policy(text, uuid) OWNER TO gatewaze_module_writer;

-- ---- content_access_visible ------------------------------------------------
CREATE OR REPLACE FUNCTION public.content_access_visible(
  p_content_type  text,
  p_entity_id     uuid,
  p_published_at  timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pol      public.content_access_policies;
  v_required boolean := false;
BEGIN
  v_pol := public.content_access_effective_policy(p_content_type, p_entity_id);
  IF v_pol.content_type IS NULL THEN
    RETURN true;
  END IF;

  IF v_pol.audience = 'members' THEN
    v_required := true;
  ELSIF v_pol.embargo_days IS NOT NULL
        AND p_published_at IS NOT NULL
        AND p_published_at > now() - make_interval(days => v_pol.embargo_days) THEN
    v_required := true;
  END IF;

  IF NOT v_required THEN
    RETURN true;
  END IF;

  -- Exact tier set takes precedence over the rank threshold.
  IF v_pol.allowed_tiers IS NOT NULL AND array_length(v_pol.allowed_tiers, 1) IS NOT NULL THEN
    IF to_regprocedure('public.current_person_member_in_tiers(text[])') IS NULL THEN
      RETURN true;
    END IF;
    RETURN public.current_person_member_in_tiers(v_pol.allowed_tiers);
  END IF;

  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;
  END IF;
  RETURN public.current_person_is_member(v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_visible(text, uuid, timestamptz) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_visible(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_visible(text, uuid, timestamptz) TO anon, authenticated, service_role;

-- ---- content_access_action_allowed -----------------------------------------
CREATE OR REPLACE FUNCTION public.content_access_action_allowed(
  p_content_type text,
  p_entity_id    uuid,
  p_action       text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pol public.content_access_policies;
BEGIN
  v_pol := public.content_access_effective_policy(p_content_type, p_entity_id);
  IF v_pol.content_type IS NULL OR NOT (p_action = ANY(v_pol.gated_actions)) THEN
    RETURN true;
  END IF;

  IF v_pol.allowed_tiers IS NOT NULL AND array_length(v_pol.allowed_tiers, 1) IS NOT NULL THEN
    IF to_regprocedure('public.current_person_member_in_tiers(text[])') IS NULL THEN
      RETURN true;
    END IF;
    RETURN public.current_person_member_in_tiers(v_pol.allowed_tiers);
  END IF;

  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;
  END IF;
  RETURN public.current_person_is_member(v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_action_allowed(text, uuid, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_action_allowed(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_action_allowed(text, uuid, text) TO anon, authenticated, service_role;

-- ---- content_access_action_allowed_email (email-keyed twin) -----------------
CREATE OR REPLACE FUNCTION public.content_access_action_allowed_email(
  p_content_type text,
  p_entity_id    uuid,
  p_action       text,
  p_email        text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pol public.content_access_policies;
BEGIN
  v_pol := public.content_access_effective_policy(p_content_type, p_entity_id);
  IF v_pol.content_type IS NULL OR NOT (p_action = ANY(v_pol.gated_actions)) THEN
    RETURN true;
  END IF;

  IF v_pol.allowed_tiers IS NOT NULL AND array_length(v_pol.allowed_tiers, 1) IS NOT NULL THEN
    IF to_regprocedure('public.membership_email_in_tiers(text, text[])') IS NULL THEN
      RETURN true;
    END IF;
    RETURN public.membership_email_in_tiers(p_email, v_pol.allowed_tiers);
  END IF;

  IF to_regprocedure('public.membership_email_is_member(text, integer)') IS NULL THEN
    RETURN true;
  END IF;
  RETURN public.membership_email_is_member(p_email, v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_action_allowed_email(text, uuid, text, text) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_action_allowed_email(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_access_action_allowed_email(text, uuid, text, text) TO service_role;

-- ---- register_content_access (add p_allowed_tiers) --------------------------
DROP FUNCTION IF EXISTS public.register_content_access(text, uuid, text, int, int, text[], jsonb, text);
CREATE OR REPLACE FUNCTION public.register_content_access(
  p_content_type  text,
  p_entity_id     uuid    DEFAULT NULL,
  p_audience      text    DEFAULT 'public',
  p_min_tier_rank int     DEFAULT 0,
  p_allowed_tiers text[]  DEFAULT NULL,
  p_embargo_days  int     DEFAULT NULL,
  p_gated_actions text[]  DEFAULT '{}',
  p_placeholder   jsonb   DEFAULT NULL,
  p_note          text    DEFAULT NULL
) RETURNS public.content_access_policies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.content_access_policies;
  v_tiers text[];
BEGIN
  IF p_content_type IS NULL OR btrim(p_content_type) = '' THEN
    RAISE EXCEPTION 'content_type is required';
  END IF;
  IF p_audience NOT IN ('public', 'members') THEN
    RAISE EXCEPTION 'audience must be public or members (got %)', p_audience;
  END IF;

  -- Normalise: empty array -> NULL (means "use the min_tier_rank threshold").
  v_tiers := CASE WHEN p_allowed_tiers IS NOT NULL AND array_length(p_allowed_tiers, 1) IS NOT NULL
                  THEN p_allowed_tiers ELSE NULL END;

  UPDATE public.content_access_policies SET
    audience      = p_audience,
    min_tier_rank = COALESCE(p_min_tier_rank, 0),
    allowed_tiers = v_tiers,
    embargo_days  = p_embargo_days,
    gated_actions = COALESCE(p_gated_actions, '{}'),
    placeholder   = p_placeholder,
    note          = p_note,
    updated_at    = now()
  WHERE content_type = p_content_type
    AND entity_id IS NOT DISTINCT FROM p_entity_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    INSERT INTO public.content_access_policies
      (content_type, entity_id, audience, min_tier_rank, allowed_tiers,
       embargo_days, gated_actions, placeholder, note)
    VALUES
      (p_content_type, p_entity_id, p_audience, COALESCE(p_min_tier_rank, 0), v_tiers,
       p_embargo_days, COALESCE(p_gated_actions, '{}'), p_placeholder, p_note)
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END $$;
ALTER FUNCTION public.register_content_access(text, uuid, text, int, text[], int, text[], jsonb, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.register_content_access(text, uuid, text, int, text[], int, text[], jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_content_access(text, uuid, text, int, text[], int, text[], jsonb, text) TO service_role;
