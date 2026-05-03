-- Allow anonymous access to newsletter data for the portal.
-- The portal reads newsletter collections and published editions without authentication.

-- Template collections (newsletters) — anon can read
DROP POLICY IF EXISTS newsletters_collections_anon_select ON public.newsletters_template_collections;
CREATE POLICY newsletters_collections_anon_select ON public.newsletters_template_collections
  FOR SELECT TO anon USING (true);

-- Editions — anon can read published editions
DROP POLICY IF EXISTS newsletters_editions_anon_select ON public.newsletters_editions;
CREATE POLICY newsletters_editions_anon_select ON public.newsletters_editions
  FOR SELECT TO anon USING (status = 'published');

-- Edition blocks — anon can read (needed to render newsletter content)
DROP POLICY IF EXISTS newsletters_blocks_anon_select ON public.newsletters_edition_blocks;
CREATE POLICY newsletters_blocks_anon_select ON public.newsletters_edition_blocks
  FOR SELECT TO anon USING (true);

-- Block templates — anon can read
DROP POLICY IF EXISTS newsletters_block_templates_anon_select ON public.newsletters_block_templates;
CREATE POLICY newsletters_block_templates_anon_select ON public.newsletters_block_templates
  FOR SELECT TO anon USING (true);
