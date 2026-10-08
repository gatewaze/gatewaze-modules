-- ============================================================================
-- Module: broadcasts
-- Migration: 028_broadcast_template_library
-- Description: One shared template library for all broadcasts, managed from
-- a broadcast's Template tab (super admins). Registers 'broadcasts' as a
-- templates host so the templates RLS dispatcher can resolve the admin
-- check for it, creates the library row (host_id NULL: there is one per
-- installation), and narrows broadcasts.template to the two shells that
-- remain — the built-in plain email (default) or that library's wrapper.
-- The 'classic' column shell introduced in 027 is gone; broadcasts that had
-- it render as plain the next time their content is saved.
-- ============================================================================

-- Admin check the templates dispatcher calls with the host id (NULL here).
CREATE OR REPLACE FUNCTION public.can_admin_broadcasts(p_host_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin();
$$;
REVOKE ALL ON FUNCTION public.can_admin_broadcasts(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_admin_broadcasts(uuid) TO authenticated, anon;

INSERT INTO public.pages_host_registrations (
  host_kind, module_id, url_prefix_template,
  can_admin_fn, can_edit_pages_fn, can_publish_fn,
  default_wrapper_key, accepted_theme_kinds, enabled
)
VALUES (
  'broadcasts', 'broadcasts', '/broadcasts',
  'public.can_admin_broadcasts', 'public.can_admin_broadcasts', 'public.can_admin_broadcasts',
  'default', ARRAY['email']::text[], true
)
ON CONFLICT (host_kind) DO NOTHING;

INSERT INTO public.templates_libraries (host_kind, host_id, name, description)
SELECT 'broadcasts', NULL, 'Broadcast templates', 'Shared wrapper and blocks for broadcasts that opt out of the plain email shell.'
WHERE NOT EXISTS (SELECT 1 FROM public.templates_libraries WHERE host_kind = 'broadcasts' AND host_id IS NULL);

ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_template_check;
UPDATE public.broadcasts SET template = 'plain' WHERE template NOT IN ('plain', 'repo');
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_template_check CHECK (template IN ('plain', 'repo'));
