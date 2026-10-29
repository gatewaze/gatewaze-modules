-- ============================================================================
-- Module: custom-domains
-- Migration: 002_theme
-- Description: A domain's own look. Tokens only (colours, fonts, logo,
--              radius, light or dark), checked by the api on write and by
--              the portal on read; the portal middleware forwards it to
--              the layout, which sets it as CSS variables on <html>.
-- ============================================================================

ALTER TABLE public.custom_domains
  ADD COLUMN IF NOT EXISTS theme jsonb;

COMMENT ON COLUMN public.custom_domains.theme IS
  'The domain''s look: {mode, colors:{background,surface,text,muted,primary,primaryText,border}, fonts:{heading,body}, logoUrl, radius}. Validated in lib/theme.ts; the portal re-checks it on read.';
