-- ============================================================================
-- Migration: sites_029_brand_assets_library
-- Description: Cross-site shared "brand assets" media library.
--              Per spec-content-modules-git-architecture §3 (v1.x deferral).
--
-- Architecture:
--   - host_media is per-site/per-list scope (existing in 015)
--   - brand_assets is org/install-wide scope (new in this migration)
--   - Sites reference brand_assets via the same /media/brand/<slug>
--     URL pattern in content; the publish-time URL rewriter looks up
--     brand_assets first, falls back to host_media
--
-- Use cases:
--   - Logo (used on every site + every newsletter)
--   - Brand fonts (referenced from theme.json across sites)
--   - Standard hero photography pool
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.brand_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Slug used in /media/brand/<slug> references (kebab-case, unique per install)
  slug          text NOT NULL UNIQUE,
  storage_path  text NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  bytes         bigint NOT NULL,
  width         integer,
  height        integer,
  variants      jsonb,
  alt_text      text,                                -- accessibility default; sites can override
  caption       text,
  category      text NOT NULL DEFAULT 'general'
                CHECK (category IN ('logo', 'icon', 'photography', 'illustration', 'video', 'general')),
  -- Usage tracking — populated by the publish-time rewriter
  used_in_sites jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{site_id, count}]
  used_in_lists jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.brand_assets IS
  'Per spec §3 (v1.x): install-wide media library. Referenced from any site/list via /media/brand/<slug>. The publish-time URL rewriter resolves this BEFORE checking per-host host_media.';

CREATE INDEX IF NOT EXISTS idx_brand_assets_slug ON public.brand_assets (slug);
CREATE INDEX IF NOT EXISTS idx_brand_assets_category ON public.brand_assets (category);

-- ============================================================================
-- RLS — platform admins read/write; anon can read (public CDN access)
-- ============================================================================

ALTER TABLE public.brand_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brand_assets_admin_all"
  ON public.brand_assets FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "brand_assets_anon_read"
  ON public.brand_assets FOR SELECT TO anon
  USING (true);  -- assets are public by definition (logos etc.); access_level not modeled here
