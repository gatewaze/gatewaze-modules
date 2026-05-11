-- ============================================================================
-- 029_can_admin_newsletter_uuid — wrap is_admin() in a uuid-arg signature
-- ============================================================================
--
-- The templates module's RLS resolver (`templates.can_read_library`) reads
-- pages_host_registrations.can_admin_fn and resolves it as `<fn>(uuid)` —
-- it does `to_regprocedure(rtrim(can_admin_fn, '()') || '(uuid)')` and
-- bails to FALSE if the (uuid)-arg overload doesn't exist.
--
-- Earlier migrations registered `public.is_admin()` (no args) as the
-- newsletter admin check. The resolver looked for `public.is_admin(uuid)`,
-- didn't find it, and the templates_sources/templates_libraries reads all
-- returned zero rows for ANY caller — including admins. Symptoms: the
-- Source tab kept showing "No sources configured yet" even after a
-- successful Connect Repository (the row existed, the POST returned 200,
-- but the subsequent SELECT was RLS-filtered out).
--
-- Provide the uuid-arg wrapper and re-point the registration at it. The
-- wrapper ignores the newsletter id and delegates to public.is_admin() —
-- the registration just needs a function with the right signature; the
-- actual authorisation policy stays the same (any admin can administer
-- any newsletter).
--
-- Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_admin_newsletter(p_newsletter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT public.is_admin();
$$;

UPDATE public.pages_host_registrations
   SET can_admin_fn = 'public.can_admin_newsletter'
 WHERE host_kind = 'newsletter';
