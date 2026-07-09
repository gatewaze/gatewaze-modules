-- Multi-provider short links: the platform now supports self-hosted Umami
-- Links alongside Short.io/Bitly. `shortio_id` keeps its name for
-- backwards-compatibility but stores whichever provider's link id created
-- the row; `provider` disambiguates.

ALTER TABLE public.redirects
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'shortio';

COMMENT ON COLUMN public.redirects.shortio_id IS
  'Provider link id (name is historical — see provider column; umami rows store the umami link uuid here)';
COMMENT ON COLUMN public.redirects.provider IS
  'Short-link provider that owns this row: shortio | bitly | umami';

CREATE INDEX IF NOT EXISTS idx_redirects_provider ON public.redirects (provider);
