-- ============================================================================
-- Migration: sites_017_auth_columns
-- Description: Site-level auth opt-in + brand-wide SSO config.
--              Per spec-content-modules-git-architecture §12.
-- ============================================================================

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS auth_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sites.auth_enabled IS
  'Per spec §12.1: when true, /account/* routes auto-generated; useCurrentUser/useUserRelation become functional; publishing target validated to be SSR-capable.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS auth_providers text[] NOT NULL DEFAULT ARRAY['email'];

COMMENT ON COLUMN public.sites.auth_providers IS
  'Supabase Auth providers enabled for this site. Defaults to email; extend with google, github, etc.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS auth_session_cookie_domain text;

COMMENT ON COLUMN public.sites.auth_session_cookie_domain IS
  'NULL = brand-wide default (.brandname.com — supports SSO across portal + sites). Override for per-site isolation; discouraged.';

-- ============================================================================
-- Validation trigger: auth_enabled requires SSR-capable publishing target
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_sites_auth_requires_ssr()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_target_kind text;
  v_publisher_id text;
BEGIN
  IF NEW.auth_enabled = false THEN
    RETURN NEW;
  END IF;
  v_target_kind := NEW.publishing_target->>'kind';
  v_publisher_id := NEW.publishing_target->>'publisherId';
  -- k8s-internal and portal are SSR-capable
  IF v_target_kind IN ('k8s-internal', 'portal') THEN
    RETURN NEW;
  END IF;
  -- External publishers: only allowed if Functions are enabled (we trust the operator
  -- to declare this via a flag on the publisher config; checked at API layer).
  IF v_target_kind = 'external' THEN
    -- Defer the SSR-capability check to the API layer — publisher modules
    -- declare their SSR support themselves. Migration only blocks pure static
    -- when we know the target_kind precludes auth.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'auth_requires_ssr_target: site % cannot enable auth with publishing_target.kind=%; use k8s-internal or external publisher with Functions support', NEW.id, v_target_kind
    USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS trg_sites_auth_requires_ssr_ins_upd ON public.sites;
CREATE TRIGGER trg_sites_auth_requires_ssr_ins_upd
  BEFORE INSERT OR UPDATE OF auth_enabled, publishing_target ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.trg_sites_auth_requires_ssr();
