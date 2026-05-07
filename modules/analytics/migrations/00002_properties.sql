-- ============================================================================
-- Migration: analytics_00002_properties
-- Description: Property registry + per-property secrets + custom-event
--              registry. The unit of measurement, permission, and snippet.
--              Per spec-analytics-module §5.2.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. analytics_properties — the unit of measurement
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The id baked into the embed snippet. NEVER rotated — rotating it
  -- would break every <script> tag the operator has copy-pasted into
  -- external sites. If a property is compromised, archive it and create
  -- a new one.
  property_id     uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('gatewaze_site', 'gatewaze_host', 'portal', 'external')),
  name            text NOT NULL,
  -- For 'gatewaze_site' / 'gatewaze_host': link back to the host_kind +
  -- host_id (matches the dispatch in spec-sites-module §4.4).
  host_kind       text,
  host_id         uuid,
  -- Origin allow-list for the ingest endpoint. '*' permitted ONLY for
  -- kind='external' — sites/portal properties always ship a concrete
  -- domain list so a misconfigured CORS doesn't leak ingest to other
  -- origins (CHECK below).
  domains         text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Filled by the provisioning worker once Umami's `website` row exists.
  -- Until then, status='pending' and the embed snippet returns a no-op.
  website_uuid    uuid,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,                 -- platform user id; non-FK by convention
  -- Kind-specific invariants
  CONSTRAINT analytics_properties_host_fields_when_gatewaze CHECK (
    (kind IN ('gatewaze_site', 'gatewaze_host') AND host_kind IS NOT NULL AND host_id IS NOT NULL)
    OR (kind IN ('portal', 'external') AND host_id IS NULL)
  ),
  CONSTRAINT analytics_properties_wildcard_only_for_external CHECK (
    NOT ('*' = ANY(domains)) OR kind = 'external'
  )
);

COMMENT ON TABLE public.analytics_properties IS
  'Tracking properties — one per Gatewaze site, one per portal, one per registered external site.';
COMMENT ON COLUMN public.analytics_properties.property_id IS
  'Stable id baked into the embed snippet. NEVER rotated; archive + recreate if compromised.';
COMMENT ON COLUMN public.analytics_properties.website_uuid IS
  'Umami website.website_id, filled by the provisioning worker. NULL while status=pending.';

-- Uniqueness for the auto-managed kinds (one property per host). 'external'
-- has no uniqueness constraint — admin can register as many as they like.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_properties_unique_per_host
  ON public.analytics_properties (kind, host_kind, host_id)
  WHERE kind IN ('gatewaze_site', 'gatewaze_host');

CREATE UNIQUE INDEX IF NOT EXISTS analytics_properties_unique_portal
  ON public.analytics_properties (kind)
  WHERE kind = 'portal';

CREATE INDEX IF NOT EXISTS analytics_properties_status
  ON public.analytics_properties (status);

CREATE INDEX IF NOT EXISTS analytics_properties_kind
  ON public.analytics_properties (kind);

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'analytics_properties_updated_at') THEN
    CREATE TRIGGER analytics_properties_updated_at
      BEFORE UPDATE ON public.analytics_properties
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. analytics_secrets — per-property secrets (Segment write key etc.)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES public.analytics_properties(property_id) ON DELETE CASCADE,
  key             text NOT NULL,                  -- e.g. 'segment_write_key'
  -- Envelope-encrypted via the platform key (matches spec-sites-module
  -- secrets handling). Decryption happens server-side; the value never
  -- leaves the cluster boundary.
  encrypted_value bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (property_id, key)
);

COMMENT ON TABLE public.analytics_secrets IS
  'Per-property secrets — Segment write keys, future API keys. Envelope-encrypted; never returned via any read API.';

CREATE INDEX IF NOT EXISTS analytics_secrets_property
  ON public.analytics_secrets (property_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'analytics_secrets_updated_at') THEN
    CREATE TRIGGER analytics_secrets_updated_at
      BEFORE UPDATE ON public.analytics_secrets
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. analytics_custom_events — registry of event names a property emits
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_custom_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES public.analytics_properties(property_id) ON DELETE CASCADE,
  event_name    text NOT NULL,
  description   text,
  -- Where the event was declared: 'block_def:<key>' for theme block defs
  -- that auto-register events at parse time, 'manual' for admin-typed,
  -- 'system' for Gatewaze-internal (page_view, ab_assignment).
  declared_by   text NOT NULL DEFAULT 'manual'
    CHECK (declared_by ~ '^(block_def:.+|manual|system)$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, event_name)
);

COMMENT ON TABLE public.analytics_custom_events IS
  'Registry of custom event names per property. Surfaced in dashboards + the A/B goal-event picker.';

CREATE INDEX IF NOT EXISTS analytics_custom_events_property
  ON public.analytics_custom_events (property_id);

-- ----------------------------------------------------------------------------
-- 4. RLS — gate everything via the helpers from 00001 (now reified below)
-- ----------------------------------------------------------------------------

ALTER TABLE public.analytics_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_custom_events ENABLE ROW LEVEL SECURITY;

-- Reify the helper functions now that analytics_properties exists.
CREATE OR REPLACE FUNCTION public.can_read_analytics_property(p_property_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_host_kind text;
  v_host_id uuid;
BEGIN
  -- Service role always allowed (workers, the renderer's same-process lookup)
  IF current_setting('role', true) IN ('service_role', 'postgres') THEN
    RETURN true;
  END IF;

  SELECT kind, host_kind, host_id INTO v_kind, v_host_kind, v_host_id
  FROM public.analytics_properties
  WHERE property_id = p_property_id;
  IF v_kind IS NULL THEN RETURN false; END IF;

  -- Dispatch per kind. For host-backed properties, defer to the host's
  -- can_admin function via the pages_host_registrations pattern.
  IF v_kind IN ('gatewaze_site', 'gatewaze_host') THEN
    -- Look up the host's can_admin function and call it dynamically.
    -- Same pattern as pages RLS in spec-sites-module §4.4.
    DECLARE
      v_can_admin_fn text;
    BEGIN
      SELECT can_admin_fn INTO v_can_admin_fn
      FROM public.pages_host_registrations
      WHERE host_kind = v_host_kind;
      IF v_can_admin_fn IS NULL THEN RETURN false; END IF;
      EXECUTE format('SELECT %s($1)', v_can_admin_fn::regproc::text)
        USING v_host_id INTO STRICT v_can_admin_fn;  -- reusing var as bool target
      RETURN v_can_admin_fn::boolean;
    EXCEPTION
      WHEN undefined_function OR undefined_table THEN RETURN false;
    END;
  END IF;

  -- portal + external: super_admin only in v1
  RETURN public.is_super_admin();
EXCEPTION
  WHEN undefined_function THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_admin_analytics_property(p_property_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Stricter: same dispatch but for host-backed properties we require
  -- the host's can_admin (not just can_edit). Today our helpers are
  -- already at the can_admin level, so the body is identical to
  -- can_read; future divergence (per spec §5.4) lands here.
  RETURN public.can_read_analytics_property(p_property_id);
END;
$$;

-- analytics_properties policies
DROP POLICY IF EXISTS analytics_properties_select ON public.analytics_properties;
CREATE POLICY analytics_properties_select ON public.analytics_properties
  FOR SELECT
  USING (public.can_read_analytics_property(property_id));

DROP POLICY IF EXISTS analytics_properties_update ON public.analytics_properties;
CREATE POLICY analytics_properties_update ON public.analytics_properties
  FOR UPDATE
  USING (public.can_admin_analytics_property(property_id))
  WITH CHECK (public.can_admin_analytics_property(property_id));

DROP POLICY IF EXISTS analytics_properties_insert ON public.analytics_properties;
CREATE POLICY analytics_properties_insert ON public.analytics_properties
  FOR INSERT
  -- INSERT is super_admin only EXCEPT for gatewaze_* kinds which go via
  -- the provisioning worker as service_role. The CHECK accepts both:
  -- the sub-clause `kind IN ('gatewaze_site','gatewaze_host')` is
  -- service-role's path; super_admin covers everything else.
  WITH CHECK (
    current_setting('role', true) IN ('service_role', 'postgres')
    OR public.is_super_admin()
  );

-- analytics_secrets policies — service_role only for SELECT
-- (UI surfaces a redacted "configured ✓" rather than the value).
DROP POLICY IF EXISTS analytics_secrets_select ON public.analytics_secrets;
CREATE POLICY analytics_secrets_select ON public.analytics_secrets
  FOR SELECT
  USING (current_setting('role', true) IN ('service_role', 'postgres'));

DROP POLICY IF EXISTS analytics_secrets_write ON public.analytics_secrets;
CREATE POLICY analytics_secrets_write ON public.analytics_secrets
  FOR ALL
  USING (public.can_admin_analytics_property(property_id))
  WITH CHECK (public.can_admin_analytics_property(property_id));

-- analytics_custom_events policies — match parent property
DROP POLICY IF EXISTS analytics_custom_events_select ON public.analytics_custom_events;
CREATE POLICY analytics_custom_events_select ON public.analytics_custom_events
  FOR SELECT
  USING (public.can_read_analytics_property(property_id));

DROP POLICY IF EXISTS analytics_custom_events_write ON public.analytics_custom_events;
CREATE POLICY analytics_custom_events_write ON public.analytics_custom_events
  FOR ALL
  USING (public.can_admin_analytics_property(property_id))
  WITH CHECK (public.can_admin_analytics_property(property_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_properties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_secrets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_custom_events TO authenticated;
GRANT ALL ON public.analytics_properties TO service_role;
GRANT ALL ON public.analytics_secrets TO service_role;
GRANT ALL ON public.analytics_custom_events TO service_role;
