-- ============================================================================
-- Migration: newsletters_033_view_online_target
-- Description: Per-newsletter "view online" destination for the email header
--              link. Editions are mirrored to a static `publish` branch (and
--              are also viewable on the portal), so each newsletter chooses
--              which one its "View Online" link points at.
--
--   view_online_target:
--     'portal'   (default) → portal web-version URL (we host it, nicer URLs,
--                            analytics). Existing behaviour.
--     'external'          → the static site built from the publish branch
--                            (GitHub Pages / Netlify / Cloudflare Pages, etc.),
--                            using view_online_external_base_url as the root.
-- ============================================================================

ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS view_online_target text NOT NULL DEFAULT 'portal',
  ADD COLUMN IF NOT EXISTS view_online_external_base_url text;

-- Constrain to the two supported destinations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'newsletters_template_collections_view_online_target_check'
  ) THEN
    ALTER TABLE public.newsletters_template_collections
      ADD CONSTRAINT newsletters_template_collections_view_online_target_check
      CHECK (view_online_target IN ('portal', 'external'));
  END IF;
END $$;

COMMENT ON COLUMN public.newsletters_template_collections.view_online_target IS
  'Where the email "View Online" link points: portal (default) or external (static publish-branch site).';
COMMENT ON COLUMN public.newsletters_template_collections.view_online_external_base_url IS
  'Root URL of the static site built from the publish branch, e.g. https://newsletter.example.org. Used only when view_online_target = external.';
