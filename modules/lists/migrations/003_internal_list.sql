-- ============================================================================
-- Module: lists
-- Migration: 003_internal_list
-- Description: Introduce the concept of an "internal" list and seed a
-- well-known one. Internal lists are hidden from the portal Subscription
-- Centre entirely (the `is_internal` flag is checked in addition to the
-- existing public/subscribed visibility rules), so end users can neither see
-- nor subscribe to them. The seeded 'internal' list is intended for staff /
-- super_admin communications and is initialised with the system's current
-- super_admins.
--
-- Note: this is a ONE-TIME seed of the super_admins that exist when the
-- migration runs. On a brand-new system where the first super_admin is created
-- during onboarding (after module migrations), this list may seed empty;
-- members can be added later from the admin Lists UI.
-- Idempotent; referenced by the stable slug 'internal'.
-- ============================================================================

-- 1. Visibility flag — internal lists are never surfaced in the Subscription Centre.
ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.lists.is_internal IS
  'Internal/staff-only list. Hidden from the portal Subscription Centre regardless of is_public or existing subscriptions; users cannot see or subscribe to it.';

-- 2. Seed the well-known 'internal' list.
INSERT INTO public.lists (id, slug, name, description, is_active, is_public, is_internal, default_subscribed)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'internal',
  'Internal',
  'Internal staff communications. Hidden from the public Subscription Centre.',
  true,
  false,
  true,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- 3. Seed current super_admins as subscribers (one-time; see note above).
INSERT INTO public.list_subscriptions (list_id, person_id, email, subscribed, source)
SELECT
  'b0000000-0000-0000-0000-000000000001',
  (SELECT p.id FROM public.people p WHERE lower(p.email) = lower(ap.email) LIMIT 1),
  lower(ap.email),
  true,
  'admin'
FROM public.admin_profiles ap
WHERE ap.role = 'super_admin'
  AND ap.is_active = true
  AND ap.email IS NOT NULL
ON CONFLICT (list_id, email) DO NOTHING;
