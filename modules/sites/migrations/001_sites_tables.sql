-- ============================================================================
-- Migration: sites_001_tables
-- Description: Core site-owned tables. Per spec-sites-module.md §4.1.
--              Pages and host-polymorphic tables live in 002.
--              Triggers and RLS land in 003 / 004 / 005.
-- ============================================================================

-- ==========================================================================
-- 1. sites
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.sites (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  description           text,
  status                text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  publishing_target     jsonb NOT NULL DEFAULT '{"kind":"portal"}'::jsonb,
  custom_domain_id      uuid,                            -- FK to custom_domains.id, added when that module is installed
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  templates_library_id  uuid,                            -- FK to templates_libraries.id; deferred FK lives in §3
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid
);

CREATE INDEX IF NOT EXISTS sites_status_idx ON public.sites (status);
CREATE INDEX IF NOT EXISTS sites_templates_library_idx ON public.sites (templates_library_id);

COMMENT ON TABLE public.sites IS 'One row per site. See spec-sites-module.md §4.1.';
COMMENT ON COLUMN public.sites.publishing_target IS
  'Shape: { kind: portal|k8s-internal|external, publisherId?, configRef? }. configRef points into sites_secrets, NOT a literal token.';

-- ==========================================================================
-- 2. sites_secrets
-- ==========================================================================
-- Per-site secrets used by external-API DATA_SOURCE blocks. Encrypted at rest
-- via the platform's secrets store; the encrypted_value column stores the
-- envelope-encrypted blob.

CREATE TABLE IF NOT EXISTS public.sites_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  encrypted_value bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (site_id, key)
);

CREATE INDEX IF NOT EXISTS sites_secrets_site_idx ON public.sites_secrets (site_id);

COMMENT ON COLUMN public.sites_secrets.encrypted_value IS
  'Envelope-encrypted via the platform key. NEVER round-tripped to clients in any read endpoint.';

-- ==========================================================================
-- 3. sites_editor_permissions
-- ==========================================================================
-- Per-site editor grants. The Site Admin role is implicit from
-- can_admin_site(); this table grants the narrower Site Editor role.

CREATE TABLE IF NOT EXISTS public.sites_editor_permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,                          -- platform user
  can_publish  boolean NOT NULL DEFAULT false,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  granted_by   uuid,
  UNIQUE (site_id, user_id)
);

CREATE INDEX IF NOT EXISTS sites_editor_permissions_site_idx ON public.sites_editor_permissions (site_id);
CREATE INDEX IF NOT EXISTS sites_editor_permissions_user_idx ON public.sites_editor_permissions (user_id);

-- ==========================================================================
-- 4. sites_media
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.sites_media (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  storage_provider  text NOT NULL CHECK (storage_provider IN ('supabase', 's3', 'bunny')),
  storage_path      text NOT NULL,
  public_url        text NOT NULL,
  filename          text NOT NULL,
  mime              text NOT NULL,
  size              bigint NOT NULL CHECK (size >= 0),
  alt_text          text,
  caption           text,
  width             integer,
  height            integer,
  uploaded_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sites_media_site_idx ON public.sites_media (site_id);
CREATE INDEX IF NOT EXISTS sites_media_url_idx ON public.sites_media (public_url);

COMMENT ON TABLE public.sites_media IS
  'Per-site media library. Sync state is per-deployment, not per-asset — see sites_publisher_deployments.artifact_manifest.';

-- ==========================================================================
-- 5. sites_external_domains
-- ==========================================================================
-- Domains registered with an external publisher (Vercel/Netlify/Cloudflare).
-- Distinct from custom_domains (k8s-internal NGINX/cert-manager flow).

CREATE TABLE IF NOT EXISTS public.sites_external_domains (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id              uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  publisher_id         text NOT NULL,
  domain               text NOT NULL,
  state                text NOT NULL DEFAULT 'pending_dns'
    CHECK (state IN ('pending_dns', 'pending_verification', 'verified', 'misconfigured')),
  state_detail         text,
  dns_instructions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification_handle  text,
  last_checked_at      timestamptz,
  added_at             timestamptz NOT NULL DEFAULT now(),
  added_by             uuid,
  verified_at          timestamptz,
  UNIQUE (publisher_id, domain)
);

CREATE INDEX IF NOT EXISTS sites_external_domains_site_idx ON public.sites_external_domains (site_id);
CREATE INDEX IF NOT EXISTS sites_external_domains_state_idx ON public.sites_external_domains (state)
  WHERE state IN ('pending_dns', 'pending_verification');

-- ==========================================================================
-- 6. sites_publisher_deployments
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.sites_publisher_deployments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id               uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  publisher_id          text NOT NULL,
  status                text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','preparing','rendering','syncing_media','deploying','cancelling','succeeded','cancelled','failed')),
  status_detail         jsonb,
  artifact_manifest     jsonb,
  -- Deploy output (populated when status='succeeded'):
  public_url            text,
  publisher_deploy_id   text,
  cdn_domains           text[] NOT NULL DEFAULT ARRAY[]::text[],
  duration_ms           integer,
  -- Logs:
  log_object_key        text,
  log_truncated_tail    text,
  -- Errors:
  error                 text,
  started_at            timestamptz,
  finished_at           timestamptz,
  -- Coalescing / liveness:
  debounce_until        timestamptz,
  heartbeat_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  triggered_by          uuid
);

CREATE INDEX IF NOT EXISTS sites_publisher_deployments_site_status_idx
  ON public.sites_publisher_deployments (site_id, status);

CREATE INDEX IF NOT EXISTS sites_publisher_deployments_stuck_running_idx
  ON public.sites_publisher_deployments (heartbeat_at NULLS FIRST)
  WHERE status IN ('preparing','rendering','syncing_media','deploying','cancelling');

CREATE INDEX IF NOT EXISTS sites_publisher_deployments_orphaned_queued_idx
  ON public.sites_publisher_deployments (debounce_until)
  WHERE status = 'queued';

COMMENT ON COLUMN public.sites_publisher_deployments.log_object_key IS
  'Pointer into object storage. Full log lives there; only the last 4KB inline tail is in log_truncated_tail.';
