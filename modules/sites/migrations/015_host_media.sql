-- ============================================================================
-- Migration: sites_015_host_media
-- Description: Per-host media items (sites + lists). RLS dispatched via
--              templates.can_read_host. Per spec §13.2 + §18.3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind     text NOT NULL,                -- 'site' | 'list' | future
  host_id       uuid NOT NULL,
  storage_path  text NOT NULL,                -- relative path; resolved via storage_bucket_url
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  bytes         bigint NOT NULL,
  width         integer,
  height        integer,
  variants      jsonb,                        -- { "320": "...-w320.jpg", "640": ... } when pre-generated
  in_repo       boolean NOT NULL DEFAULT false, -- true = under repo media/, false = CDN-only
  used_in       jsonb NOT NULL DEFAULT '[]'::jsonb,
                                              -- [{type, id, name}] of referencing pages/editions
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (host_kind IN ('site', 'list', 'newsletter'))
);

COMMENT ON TABLE public.host_media IS
  'Per-host media items. Source of truth for the Media tab. used_in updated transactionally by MediaReferenceTracker on content writes (per spec §18.4).';

CREATE INDEX IF NOT EXISTS idx_host_media_host
  ON public.host_media (host_kind, host_id);

CREATE INDEX IF NOT EXISTS idx_host_media_storage_path
  ON public.host_media (storage_path);

-- ============================================================================
-- RLS — dispatch through templates host registry (mirrors templates_* RLS)
-- ============================================================================

ALTER TABLE public.host_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "host_media_read_via_host"
  ON public.host_media
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

CREATE POLICY "host_media_write_via_host"
  ON public.host_media
  FOR INSERT
  TO authenticated
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "host_media_update_via_host"
  ON public.host_media
  FOR UPDATE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id))
  WITH CHECK (templates.can_read_host(host_kind, host_id));

CREATE POLICY "host_media_delete_via_host"
  ON public.host_media
  FOR DELETE
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));

-- ============================================================================
-- Per-host quota config (resolved at row-write time)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.host_media_quotas (
  host_kind          text NOT NULL,
  host_id            uuid NOT NULL,
  total_bytes_used   bigint NOT NULL DEFAULT 0,
  total_bytes_cap    bigint NOT NULL DEFAULT 1073741824, -- 1 GB default
  per_file_cdn_cap   bigint NOT NULL DEFAULT 5242880,    -- 5 MB
  per_file_repo_cap  bigint NOT NULL DEFAULT 2097152,    -- 2 MB
  repo_dir_cap       bigint NOT NULL DEFAULT 209715200,  -- 200 MB
  PRIMARY KEY (host_kind, host_id)
);

ALTER TABLE public.host_media_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "host_media_quotas_read_via_host"
  ON public.host_media_quotas
  FOR SELECT
  TO authenticated
  USING (templates.can_read_host(host_kind, host_id));
