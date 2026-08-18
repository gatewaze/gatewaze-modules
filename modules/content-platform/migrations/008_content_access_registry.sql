-- ============================================================================
-- content-platform — unified content-access policy registry
-- ============================================================================
-- One entity-agnostic place to express "who may see / act on this content".
-- Parallels the publish_state adapter registry (001): a generic table + a
-- SECURITY DEFINER upsert RPC + membership-aware enforcement helpers that any
-- content type's RLS / API / send path can call.
--
-- A policy is keyed by (content_type, entity_id):
--   * entity_id IS NULL  -> the TYPE-LEVEL DEFAULT for that content_type
--                           (e.g. "newsletter editions younger than 30 days are
--                            members-only"), applied to every item of the type.
--   * entity_id NOT NULL -> a per-ITEM override (this one event/post/edition).
-- An item override wins over the type default.
--
-- Dimensions a policy can express:
--   audience       'public' | 'members'  — members => must be an active member.
--   min_tier_rank  int                   — 0 = any member; else >= tier_rank.
--   embargo_days   int NULL              — items younger than N days are
--                                          members-only (recent-content gating:
--                                          "show the latest to members, hide it
--                                          from everyone else until it ages out").
--   gated_actions  text[]                — item stays VISIBLE but these actions
--                                          (e.g. 'register') are members-only.
--   placeholder    jsonb NULL            — copy for a members-only placeholder
--                                          shown in place of gated block content.
--
-- Membership is one gating dimension, owned by the membership module. To keep
-- content-platform self-contained (and not force a hard migration-order
-- dependency), the enforcement helpers LATE-BIND the membership primitive
-- current_person_is_member(int) via to_regprocedure: if the membership module
-- is not installed the predicate is absent and a members policy simply has no
-- teeth (content stays visible) rather than erroring.
-- ============================================================================

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $bootstrap$;

-- ----------------------------------------------------------------------------
-- The policy registry.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.content_access_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type  text NOT NULL,
  entity_id     uuid,                       -- NULL = type-level default
  audience      text NOT NULL DEFAULT 'public'
                  CHECK (audience IN ('public', 'members')),
  min_tier_rank int  NOT NULL DEFAULT 0 CHECK (min_tier_rank >= 0),
  embargo_days  int  CHECK (embargo_days IS NULL OR embargo_days > 0),
  gated_actions text[] NOT NULL DEFAULT '{}',
  placeholder   jsonb,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_access_policies OWNER TO gatewaze_module_writer;

-- Exactly one type-level default per content_type, and one override per item.
-- (A plain UNIQUE (content_type, entity_id) would NOT dedupe type defaults,
-- because NULLs compare distinct — so two partial indexes.)
CREATE UNIQUE INDEX IF NOT EXISTS content_access_policies_type_default
  ON public.content_access_policies (content_type)
  WHERE entity_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_access_policies_item
  ON public.content_access_policies (content_type, entity_id)
  WHERE entity_id IS NOT NULL;

ALTER TABLE public.content_access_policies ENABLE ROW LEVEL SECURITY;
-- No permissive policy: only service_role (bypasses RLS) and the SECURITY
-- DEFINER helpers below may read/write. Admin surfaces go through the API,
-- which runs as service_role.

-- ----------------------------------------------------------------------------
-- Effective-policy resolution: item override wins over the type default.
-- Internal helper (returns the whole row), reused by the enforcement helpers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.content_access_effective_policy(
  p_content_type text,
  p_entity_id    uuid
) RETURNS public.content_access_policies
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT *
  FROM public.content_access_policies
  WHERE content_type = p_content_type
    AND (entity_id = p_entity_id OR entity_id IS NULL)
  ORDER BY (entity_id IS NOT NULL) DESC   -- item override first
  LIMIT 1;
$$;
ALTER FUNCTION public.content_access_effective_policy(text, uuid)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_effective_policy(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_effective_policy(text, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- content_access_visible — may the CURRENT viewer SEE this item?
-- Safe to call from an RLS USING clause and from server components. Returns
-- true when there is no restricting policy. p_published_at drives embargo
-- (pass the item's publish timestamp; NULL disables the embargo leg).
-- ----------------------------------------------------------------------------
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
    RETURN true;                                  -- no policy => public
  END IF;

  IF v_pol.audience = 'members' THEN
    v_required := true;
  ELSIF v_pol.embargo_days IS NOT NULL
        AND p_published_at IS NOT NULL
        AND p_published_at > now() - make_interval(days => v_pol.embargo_days) THEN
    v_required := true;                           -- still within the members-only window
  END IF;

  IF NOT v_required THEN
    RETURN true;
  END IF;

  -- Restriction applies: ask the membership module (if installed).
  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;                                  -- no membership system => no teeth
  END IF;
  RETURN public.current_person_is_member(v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_visible(text, uuid, timestamptz)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_visible(text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_visible(text, uuid, timestamptz)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- content_access_action_allowed — item is VISIBLE, but is this ACTION allowed
-- for the current viewer? (e.g. events shown to all, 'register' members-only.)
-- Returns true unless the action is in gated_actions and the viewer isn't a
-- qualifying member.
-- ----------------------------------------------------------------------------
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
  IF to_regprocedure('public.current_person_is_member(integer)') IS NULL THEN
    RETURN true;
  END IF;
  RETURN public.current_person_is_member(v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_action_allowed(text, uuid, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_action_allowed(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_action_allowed(text, uuid, text)
  TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- register_content_access — atomic upsert of a policy (type default or item
-- override). The single write path; admin API calls it as service_role.
-- Passing audience='public', no embargo, and empty gated_actions is the way to
-- CLEAR a restriction (idempotent). entity_id NULL sets the type default.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_content_access(
  p_content_type  text,
  p_entity_id     uuid    DEFAULT NULL,
  p_audience      text    DEFAULT 'public',
  p_min_tier_rank int     DEFAULT 0,
  p_embargo_days  int     DEFAULT NULL,
  p_gated_actions text[]  DEFAULT '{}',
  p_placeholder   jsonb   DEFAULT NULL,
  p_note          text    DEFAULT NULL
) RETURNS public.content_access_policies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.content_access_policies;
BEGIN
  IF p_content_type IS NULL OR btrim(p_content_type) = '' THEN
    RAISE EXCEPTION 'content_type is required';
  END IF;
  IF p_audience NOT IN ('public', 'members') THEN
    RAISE EXCEPTION 'audience must be public or members (got %)', p_audience;
  END IF;

  UPDATE public.content_access_policies SET
    audience      = p_audience,
    min_tier_rank = COALESCE(p_min_tier_rank, 0),
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
      (content_type, entity_id, audience, min_tier_rank,
       embargo_days, gated_actions, placeholder, note)
    VALUES
      (p_content_type, p_entity_id, p_audience, COALESCE(p_min_tier_rank, 0),
       p_embargo_days, COALESCE(p_gated_actions, '{}'), p_placeholder, p_note)
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END $$;
ALTER FUNCTION public.register_content_access(text, uuid, text, int, int, text[], jsonb, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.register_content_access(text, uuid, text, int, int, text[], jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_content_access(text, uuid, text, int, int, text[], jsonb, text) TO service_role;

-- ----------------------------------------------------------------------------
-- clear_content_access — drop a policy row entirely (distinct from setting it
-- back to public: removes the record). Idempotent.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_content_access(
  p_content_type text,
  p_entity_id    uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM public.content_access_policies
  WHERE content_type = p_content_type
    AND entity_id IS NOT DISTINCT FROM p_entity_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;
ALTER FUNCTION public.clear_content_access(text, uuid) OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.clear_content_access(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_content_access(text, uuid) TO service_role;
