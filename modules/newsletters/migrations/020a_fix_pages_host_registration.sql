-- ============================================================================
-- Migration: newsletters_020a_fix_pages_host_registration
-- Description: Fix the can_admin_fn / can_edit_pages_fn / can_publish_fn
--              registration for host_kind='newsletter'.
--
-- Background:
--   Migration 020 registered:
--     can_admin_fn = 'public.is_admin()'
--   Two issues:
--     1. Trailing '()' breaks the dispatcher's function-name parsing.
--     2. Even without the parens, public.is_admin takes ZERO args, but
--        the dispatcher passes a host_id uuid.
--   We need a wrapper public.can_admin_newsletter(uuid) that ignores the
--   host_id (newsletters use the same admin-everywhere model) and calls
--   public.is_admin().
--
--   Future per-newsletter ACL ("only this user can edit this collection")
--   would replace this wrapper's body with a row-level check against
--   newsletters_template_collections.created_by or similar.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_admin_newsletter(p_collection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin();
$$;

COMMENT ON FUNCTION public.can_admin_newsletter(uuid) IS
  'Permission helper for host_kind=newsletter rows. Currently delegates to is_admin(); replace with row-level ACL when per-newsletter ownership lands.';

-- ============================================================================
-- Update the registration to point at the new wrapper.
-- ============================================================================
--
-- The values originally written by 020 had trailing '()' which the
-- dispatcher couldn't parse. Strip them and use the proper wrapper.

UPDATE public.pages_host_registrations
SET
  can_admin_fn      = 'public.can_admin_newsletter',
  can_edit_pages_fn = 'public.can_admin_newsletter',
  can_publish_fn    = 'public.can_admin_newsletter'
WHERE host_kind = 'newsletter';

-- Defensive: if 020 hasn't been applied yet (e.g. fresh install on a self-host
-- that runs migrations top-to-bottom), insert the row.
INSERT INTO public.pages_host_registrations (
  host_kind, module_id, url_prefix_template,
  can_admin_fn, can_edit_pages_fn, can_publish_fn,
  default_wrapper_key, accepted_theme_kinds, enabled
)
VALUES (
  'newsletter', 'newsletters', '/newsletters/{host_id}',
  'public.can_admin_newsletter',
  'public.can_admin_newsletter',
  'public.can_admin_newsletter',
  null, ARRAY['email']::text[], false
)
ON CONFLICT (host_kind) DO NOTHING;
