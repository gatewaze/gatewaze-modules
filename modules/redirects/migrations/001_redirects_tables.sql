-- ============================================================================
-- Module: redirects
-- Migration: 001_redirects_tables
-- Description: Create tables for URL redirect/short link management
-- ============================================================================

-- Redirects (short.io link cache)
CREATE TABLE IF NOT EXISTS public.redirects (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortio_id              text NOT NULL UNIQUE,
  original_url            text NOT NULL,
  short_url               text NOT NULL,
  secure_short_url        text,
  path                    varchar(500) NOT NULL,
  domain                  varchar(255) NOT NULL,
  title                   text,
  archived                boolean NOT NULL DEFAULT false,
  tags                    text[],
  total_clicks            integer NOT NULL DEFAULT 0,
  unique_clicks           integer NOT NULL DEFAULT 0,
  human_clicks            integer NOT NULL DEFAULT 0,
  source_type             varchar(50),
  source_id               text,
  shortio_created_at      timestamptz,
  last_totals_synced_at   timestamptz,
  -- Categorization fields
  link_category           varchar(50),
  newsletter_date         date,
  distribution_channel    varchar(50),
  content_type            varchar(50),
  content_number          integer,
  platform                varchar(50),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.redirects IS 'Cached short.io redirect links with click analytics';

CREATE INDEX IF NOT EXISTS idx_redirects_shortio_id     ON public.redirects (shortio_id);
CREATE INDEX IF NOT EXISTS idx_redirects_path           ON public.redirects (path);
CREATE INDEX IF NOT EXISTS idx_redirects_domain         ON public.redirects (domain);
CREATE INDEX IF NOT EXISTS idx_redirects_category       ON public.redirects (link_category);
CREATE INDEX IF NOT EXISTS idx_redirects_newsletter_date ON public.redirects (newsletter_date DESC);
CREATE INDEX IF NOT EXISTS idx_redirects_content_type   ON public.redirects (content_type);
CREATE INDEX IF NOT EXISTS idx_redirects_created_at     ON public.redirects (created_at DESC);

CREATE TRIGGER redirects_updated_at
  BEFORE UPDATE ON public.redirects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Redirect prefixes (for newsletter shortcode configuration)
CREATE TABLE IF NOT EXISTS public.redirects_prefixes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix          varchar(100) NOT NULL UNIQUE,
  description     text,
  content_type    varchar(50),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.redirects_prefixes IS 'Prefix configuration for newsletter short link paths';

CREATE TRIGGER redirects_prefixes_updated_at
  BEFORE UPDATE ON public.redirects_prefixes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Redirect shortcodes (mapping patterns for link categorization)
CREATE TABLE IF NOT EXISTS public.redirects_shortcodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix          varchar(100) NOT NULL,
  shortcode       varchar(100) NOT NULL,
  content_type    varchar(50),
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prefix, shortcode)
);

COMMENT ON TABLE public.redirects_shortcodes IS 'Shortcode-to-content-type mapping rules';

CREATE INDEX IF NOT EXISTS idx_redirects_shortcodes_prefix
  ON public.redirects_shortcodes (prefix);

CREATE TRIGGER redirects_shortcodes_updated_at
  BEFORE UPDATE ON public.redirects_shortcodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Redirects stats (aggregated stats view cache)
CREATE TABLE IF NOT EXISTS public.redirects_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_type       varchar(50) NOT NULL,
  stat_key        varchar(255) NOT NULL,
  stat_value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redirects_stats_type ON public.redirects_stats (stat_type);

CREATE TRIGGER redirects_stats_updated_at
  BEFORE UPDATE ON public.redirects_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Redirects sync logs
CREATE TABLE IF NOT EXISTS public.redirects_sync_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type       varchar(50) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('started', 'completed', 'failed')),
  links_synced    integer NOT NULL DEFAULT 0,
  links_created   integer NOT NULL DEFAULT 0,
  links_updated   integer NOT NULL DEFAULT 0,
  error_message   text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redirects_sync_logs_created
  ON public.redirects_sync_logs (created_at DESC);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redirects_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redirects_shortcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redirects_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redirects_sync_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: anonymous visitors (portal redirect resolution)
CREATE POLICY "redirects_select_anon" ON public.redirects FOR SELECT TO anon USING (true);
CREATE POLICY "redirects_shortcodes_select_anon" ON public.redirects_shortcodes FOR SELECT TO anon USING (true);

-- SELECT: authenticated users
CREATE POLICY "redirects_select" ON public.redirects FOR SELECT TO authenticated USING (true);
CREATE POLICY "redirects_prefixes_select" ON public.redirects_prefixes FOR SELECT TO authenticated USING (true);
CREATE POLICY "redirects_shortcodes_select" ON public.redirects_shortcodes FOR SELECT TO authenticated USING (true);
CREATE POLICY "redirects_stats_select" ON public.redirects_stats FOR SELECT TO authenticated USING (true);
CREATE POLICY "redirects_sync_logs_select" ON public.redirects_sync_logs FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "redirects_insert" ON public.redirects FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "redirects_update" ON public.redirects FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "redirects_delete" ON public.redirects FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "redirects_prefixes_insert" ON public.redirects_prefixes FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "redirects_prefixes_update" ON public.redirects_prefixes FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "redirects_prefixes_delete" ON public.redirects_prefixes FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "redirects_shortcodes_insert" ON public.redirects_shortcodes FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "redirects_shortcodes_update" ON public.redirects_shortcodes FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "redirects_shortcodes_delete" ON public.redirects_shortcodes FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "redirects_stats_insert" ON public.redirects_stats FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "redirects_stats_update" ON public.redirects_stats FOR UPDATE TO authenticated USING (public.is_admin());

CREATE POLICY "redirects_sync_logs_insert" ON public.redirects_sync_logs FOR INSERT TO authenticated WITH CHECK (public.is_admin());
