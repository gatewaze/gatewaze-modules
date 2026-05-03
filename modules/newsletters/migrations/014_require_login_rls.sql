-- Fix anon RLS: hide require_login newsletters from anonymous users.
-- Also restrict anon edition access to only editions from public newsletters.

-- Collections: anon can only see public newsletters
DROP POLICY IF EXISTS newsletters_collections_anon_select ON public.newsletters_template_collections;
CREATE POLICY newsletters_collections_anon_select ON public.newsletters_template_collections
  FOR SELECT TO anon USING (require_login IS NOT TRUE);

-- Editions: anon can only see published editions from public newsletters
DROP POLICY IF EXISTS newsletters_editions_anon_select ON public.newsletters_editions;
CREATE POLICY newsletters_editions_anon_select ON public.newsletters_editions
  FOR SELECT TO anon USING (
    status = 'published'
    AND collection_id IN (
      SELECT id FROM public.newsletters_template_collections
      WHERE require_login IS NOT TRUE
    )
  );
