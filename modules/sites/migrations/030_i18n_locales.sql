-- ============================================================================
-- Migration: sites_030_i18n_locales
-- Description: Multi-language i18n for sites + menus.
--              Per spec-content-modules-git-architecture §3 (v1.x deferral).
--
-- Architecture:
--   - sites.supported_locales: BCP-47 codes the site is published in
--   - sites.default_locale: which locale is served at the un-prefixed URL
--   - pages.locale: per-page locale; locale-prefixed URLs (/en/foo, /es/foo)
--   - pages.translation_of: links localized pages back to their canonical
--     source for the editor's "Translate this page" UX
--   - navigation_menu_items.label_translations: per-locale label overrides
--   - host_media.alt_text_translations: per-locale alt text
--
-- Out of scope for this migration:
--   - Translation memory / fuzzy matching
--   - Auto-translate via AI providers (similar pattern to ai-alt-text;
--     plugged at admin-edit time)
--   - URL routing rewrites (handled at the portal middleware)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sites: supported locales
-- ----------------------------------------------------------------------------

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS supported_locales text[] NOT NULL DEFAULT ARRAY['en'];

COMMENT ON COLUMN public.sites.supported_locales IS
  'BCP-47 locale codes the site publishes pages in. e.g. ARRAY[''en'', ''es'', ''de'']. Default [''en''] for backwards compat.';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS default_locale text NOT NULL DEFAULT 'en';

COMMENT ON COLUMN public.sites.default_locale IS
  'Locale served at the un-prefixed URL (e.g. /, /about). Other locales served at /<locale>/path (e.g. /es/about).';

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS locale_routing text NOT NULL DEFAULT 'subpath'
  CHECK (locale_routing IN ('subpath', 'subdomain', 'none'));

COMMENT ON COLUMN public.sites.locale_routing IS
  'How non-default locales are routed: subpath = /es/about; subdomain = es.<slug>.sites.<brand>.com (requires wildcard cert at brand level); none = single locale only.';

-- Validate default_locale is in supported_locales (deferred CHECK via trigger)
CREATE OR REPLACE FUNCTION public.trg_sites_default_locale_in_supported()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.default_locale IS NULL OR array_length(NEW.supported_locales, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW.default_locale = ANY(NEW.supported_locales)) THEN
    RAISE EXCEPTION 'default_locale % not in supported_locales %', NEW.default_locale, NEW.supported_locales
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sites_default_locale_in_supported_iud ON public.sites;
CREATE TRIGGER trg_sites_default_locale_in_supported_iud
  BEFORE INSERT OR UPDATE OF supported_locales, default_locale ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.trg_sites_default_locale_in_supported();

-- ----------------------------------------------------------------------------
-- Pages: per-page locale + translation_of FK
-- ----------------------------------------------------------------------------

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

COMMENT ON COLUMN public.pages.locale IS
  'BCP-47 locale code for this page. Must be in the parent site''s supported_locales (enforced by trigger when sites_010 site row exists).';

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS translation_of uuid REFERENCES public.pages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.pages.translation_of IS
  'Optional FK back to the canonical (default-locale) page this is a translation of. Editor uses this to surface "Translate this page" links + show translation status. NULL for canonical pages.';

-- Index for fast translation lookup
CREATE INDEX IF NOT EXISTS idx_pages_translation_of
  ON public.pages (translation_of)
  WHERE translation_of IS NOT NULL;

-- A page is unique by (site_id, locale, full_path) — same path can exist
-- in different locales (e.g. /about in en + /about in es).
DROP INDEX IF EXISTS idx_pages_unique_full_path;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_unique_locale_full_path
  ON public.pages (host_kind, host_id, locale, full_path)
  WHERE status != 'archived';

-- ----------------------------------------------------------------------------
-- Navigation menu items: per-locale label overrides
-- ----------------------------------------------------------------------------

ALTER TABLE public.navigation_menu_items
  ADD COLUMN IF NOT EXISTS label_translations jsonb;

COMMENT ON COLUMN public.navigation_menu_items.label_translations IS
  'Per-locale label overrides: { "es": "Acerca de", "de": "Über uns" }. The runtime hook useNavigationMenu reads this and serves the right label for the current locale; fallback to the base `label` field when no translation present.';

-- ----------------------------------------------------------------------------
-- Host media: per-locale alt text
-- ----------------------------------------------------------------------------

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS alt_text text;

COMMENT ON COLUMN public.host_media.alt_text IS
  'Default alt text for the asset (in the site''s default_locale). The AI alt-text generator (lib/media/ai-alt-text.ts) populates this on upload when configured.';

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS alt_text_translations jsonb;

COMMENT ON COLUMN public.host_media.alt_text_translations IS
  'Per-locale alt text overrides: { "es": "Descripción", "de": "Beschreibung" }. Same pattern as navigation_menu_items.label_translations.';
