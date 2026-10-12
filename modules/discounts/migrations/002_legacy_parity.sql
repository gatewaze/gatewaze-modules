-- ============================================================================
-- Module: discounts
-- Migration: 002_legacy_parity
-- Description: Bring the discounts schema up to what the module's own admin,
--              portal and Luma code already read and write, which is the shape
--              the original gatewaze-admin used. Also closes three exposure
--              holes that would have published claimant emails once data
--              landed in these tables.
--
-- Context: the admin pages and edge functions in this module were ported from
-- gatewaze-admin nearly verbatim, but 000/001 never added the matching
-- columns, the claims table, or the issue-code RPC. Saving a discount failed
-- (the form writes six missing columns), a claim had nowhere to go, and the
-- portal called an RPC that did not exist.
--
-- Every table touched here is empty on every brand at the time of writing,
-- so the constraint and NOT NULL changes are safe.
-- ============================================================================

-- ==========================================================================
-- 1. events_discounts: the old per-discount settings
-- ==========================================================================

ALTER TABLE public.events_discounts
  -- The original app allowed a discount with no event (four historical
  -- techtickets discounts have none).
  ALTER COLUMN event_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS content           text,
  ADD COLUMN IF NOT EXISTS hidden            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_codes         integer,
  ADD COLUMN IF NOT EXISTS luma_event_api_id text,
  ADD COLUMN IF NOT EXISTS luma_percent_off  integer;

COMMENT ON COLUMN public.events_discounts.content IS
  'Rich HTML body shown on the portal (sanitised on render)';
COMMENT ON COLUMN public.events_discounts.hidden IS
  'Hidden from anonymous visitors unless the URL carries ?discount=true. A display rule, not access control.';
COMMENT ON COLUMN public.events_discounts.max_codes IS
  'Cap on codes issued for this discount. Enforced in Luma mode.';
COMMENT ON COLUMN public.events_discounts.luma_event_api_id IS
  'When set, codes are minted as single-use Luma coupons on this Luma event instead of drawn from a pre-loaded pool';
COMMENT ON COLUMN public.events_discounts.luma_percent_off IS
  'Percent off for minted Luma coupons; the issuing function defaults to 100 when null';

ALTER TABLE public.events_discounts
  DROP CONSTRAINT IF EXISTS events_discounts_max_codes_check,
  ADD CONSTRAINT events_discounts_max_codes_check
    CHECK (max_codes IS NULL OR max_codes >= 0),
  DROP CONSTRAINT IF EXISTS events_discounts_luma_percent_off_check,
  ADD CONSTRAINT events_discounts_luma_percent_off_check
    CHECK (luma_percent_off IS NULL OR luma_percent_off BETWEEN 0 AND 100);

-- 'cancelled' is used by the historical data and by the admin status menu.
ALTER TABLE public.events_discounts
  DROP CONSTRAINT IF EXISTS events_discounts_status_check;
ALTER TABLE public.events_discounts
  ADD CONSTRAINT events_discounts_status_check
    CHECK (status IN ('draft', 'active', 'closed', 'expired', 'cancelled'));

-- ==========================================================================
-- 2. events_discount_secrets: the Luma API key, kept OFF the public table
-- ==========================================================================
-- The original app stored luma_api_key as a column on the discount row, and
-- both portals read that row with select('*') as an anonymous visitor, so the
-- key was public. It lives in its own table that only admins and the service
-- role can read. A discount may target a different Luma account from the
-- platform-wide LUMA_API_KEY, which is why this stays per discount.

CREATE TABLE IF NOT EXISTS public.events_discount_secrets (
  discount_id   uuid PRIMARY KEY REFERENCES public.events_discounts(id) ON DELETE CASCADE,
  luma_api_key  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_discount_secrets IS
  'Per-discount credentials. Never readable by anon or by non-admin users.';

DROP TRIGGER IF EXISTS events_discount_secrets_updated_at ON public.events_discount_secrets;
CREATE TRIGGER events_discount_secrets_updated_at
  BEFORE UPDATE ON public.events_discount_secrets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.events_discount_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.events_discount_secrets FROM anon;

DROP POLICY IF EXISTS "events_discount_secrets_admin_all" ON public.events_discount_secrets;
CREATE POLICY "events_discount_secrets_admin_all"
  ON public.events_discount_secrets FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- If a brand ever had luma_api_key added to events_discounts by hand, move the
-- values into the secrets table and drop the public column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events_discounts' AND column_name = 'luma_api_key'
  ) THEN
    INSERT INTO public.events_discount_secrets (discount_id, luma_api_key)
      SELECT id, luma_api_key FROM public.events_discounts WHERE luma_api_key IS NOT NULL
      ON CONFLICT (discount_id) DO UPDATE SET luma_api_key = EXCLUDED.luma_api_key;
    ALTER TABLE public.events_discounts DROP COLUMN luma_api_key;
  END IF;
END $$;

-- ==========================================================================
-- 3. events_discounts RLS: any signed-in member could edit discounts
-- ==========================================================================
-- auth_all_events_discounts granted ALL to every authenticated user, and portal
-- members sign in by magic link, so any member could create, rewrite or delete
-- a discount. Reads stay open (the portal lists discounts); writes are admin.

DROP POLICY IF EXISTS "auth_all_events_discounts" ON public.events_discounts;

DROP POLICY IF EXISTS "auth_select_events_discounts" ON public.events_discounts;
CREATE POLICY "auth_select_events_discounts"
  ON public.events_discounts FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "admin_write_events_discounts" ON public.events_discounts;
CREATE POLICY "admin_write_events_discounts"
  ON public.events_discounts FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ==========================================================================
-- 4. events_discount_codes: the old code model
-- ==========================================================================

ALTER TABLE public.events_discount_codes
  -- Historical codes exist for events that no longer exist; their original
  -- identifier is kept in legacy_event_ref.
  ALTER COLUMN event_id       DROP NOT NULL,
  -- Pool codes and minted Luma codes never carried a type or value.
  ALTER COLUMN discount_type  DROP NOT NULL,
  ALTER COLUMN discount_value DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS discount_id           uuid REFERENCES public.events_discounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source                text,
  ADD COLUMN IF NOT EXISTS registered            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attended              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registered_at         timestamptz,
  ADD COLUMN IF NOT EXISTS attended_at           timestamptz,
  ADD COLUMN IF NOT EXISTS member_profile_id     uuid,
  ADD COLUMN IF NOT EXISTS event_registration_id uuid,
  ADD COLUMN IF NOT EXISTS legacy_event_ref      text;

COMMENT ON COLUMN public.events_discount_codes.discount_id IS
  'The discount this code belongs to. Null for codes loaded per event with no discount.';
COMMENT ON COLUMN public.events_discount_codes.source IS
  'Channel label (e.g. techtickets, partner, newsletter)';
COMMENT ON COLUMN public.events_discount_codes.registered IS
  'The holder registered for the event (set on registration or by CSV upload)';
COMMENT ON COLUMN public.events_discount_codes.attended IS
  'The holder attended the event (set at check-in or by CSV upload)';
COMMENT ON COLUMN public.events_discount_codes.legacy_event_ref IS
  'Original text event identifier from gatewaze-admin, kept when the event no longer exists';

-- Links are conditional so this migration does not depend on install order.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_registrations')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_discount_codes_event_registration_id_fkey') THEN
    ALTER TABLE public.events_discount_codes
      ADD CONSTRAINT events_discount_codes_event_registration_id_fkey
      FOREIGN KEY (event_registration_id) REFERENCES public.events_registrations(id) ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'people_profiles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_discount_codes_member_profile_id_fkey') THEN
    ALTER TABLE public.events_discount_codes
      ADD CONSTRAINT events_discount_codes_member_profile_id_fkey
      FOREIGN KEY (member_profile_id) REFERENCES public.people_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_discount_codes_discount
  ON public.events_discount_codes (discount_id);
CREATE INDEX IF NOT EXISTS idx_events_discount_codes_issued_to
  ON public.events_discount_codes (lower(issued_to)) WHERE issued_to IS NOT NULL;
-- Drawing the next unissued code from an event's pool.
CREATE INDEX IF NOT EXISTS idx_events_discount_codes_pool
  ON public.events_discount_codes (event_id, created_at) WHERE issued = false;

-- ==========================================================================
-- 5. events_discount_codes RLS: issued codes were public
-- ==========================================================================
-- discount_codes_select_anon allowed any anonymous visitor to read every issued
-- code and the email it was issued to. The portal only ever needed a count,
-- which now comes from events_get_issued_codes_count() below.

DROP POLICY IF EXISTS "discount_codes_select_anon" ON public.events_discount_codes;
DROP POLICY IF EXISTS "discount_codes_select"      ON public.events_discount_codes;
DROP POLICY IF EXISTS "discount_codes_insert"      ON public.events_discount_codes;
DROP POLICY IF EXISTS "discount_codes_update"      ON public.events_discount_codes;
DROP POLICY IF EXISTS "discount_codes_delete"      ON public.events_discount_codes;

-- Admins see every code, including historical ones whose event is gone
-- (event_id null), which the event-scoped check alone would hide.
DROP POLICY IF EXISTS "discount_codes_admin_all" ON public.events_discount_codes;
CREATE POLICY "discount_codes_admin_all"
  ON public.events_discount_codes FOR ALL TO authenticated
  USING (public.is_admin() OR (event_id IS NOT NULL AND public.can_admin_event(event_id)))
  WITH CHECK (public.is_admin() OR (event_id IS NOT NULL AND public.can_admin_event(event_id)));

-- A member can see the codes issued to their own address.
DROP POLICY IF EXISTS "discount_codes_select_own" ON public.events_discount_codes;
CREATE POLICY "discount_codes_select_own"
  ON public.events_discount_codes FOR SELECT TO authenticated
  USING (issued AND issued_to IS NOT NULL
         AND lower(issued_to) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ==========================================================================
-- 6. events_discount_claims: who claimed which discount
-- ==========================================================================
-- The admin event tab and claimants page already read this table. For a pool
-- (non-Luma) discount it is the record of who claimed; for a Luma discount the
-- issued codes are.

CREATE TABLE IF NOT EXISTS public.events_discount_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id       uuid NOT NULL REFERENCES public.events_discounts(id) ON DELETE CASCADE,
  email             text NOT NULL,
  member_profile_id uuid,
  status            text NOT NULL DEFAULT 'viewed'
                      CHECK (status IN ('viewed', 'accepted', 'code-issued',
                                        'deposit-initiated', 'deposit-paid', 'sold-out')),
  referrer          text,
  viewed_at         timestamptz,
  accepted_at       timestamptz,
  code_issued_at    timestamptz,
  claim_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_discount_claims IS
  'Per-discount claim record. Status values mirror the Customer.io offer_status vocabulary.';

CREATE INDEX IF NOT EXISTS idx_events_discount_claims_discount
  ON public.events_discount_claims (discount_id);
CREATE INDEX IF NOT EXISTS idx_events_discount_claims_email
  ON public.events_discount_claims (discount_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_events_discount_claims_status
  ON public.events_discount_claims (discount_id, status);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'people_profiles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_discount_claims_member_profile_id_fkey') THEN
    ALTER TABLE public.events_discount_claims
      ADD CONSTRAINT events_discount_claims_member_profile_id_fkey
      FOREIGN KEY (member_profile_id) REFERENCES public.people_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS events_discount_claims_updated_at ON public.events_discount_claims;
CREATE TRIGGER events_discount_claims_updated_at
  BEFORE UPDATE ON public.events_discount_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.events_discount_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.events_discount_claims FROM anon;

DROP POLICY IF EXISTS "events_discount_claims_admin_all" ON public.events_discount_claims;
CREATE POLICY "events_discount_claims_admin_all"
  ON public.events_discount_claims FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "events_discount_claims_select_own" ON public.events_discount_claims;
CREATE POLICY "events_discount_claims_select_own"
  ON public.events_discount_claims FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ==========================================================================
-- 7. Interaction mirrors (Customer.io offer events)
-- ==========================================================================
-- These are derived copies of Customer.io events, not a source of truth.
-- offer_id is the offer SLUG (e.g. discount-pytorch-2025), never a uuid.

ALTER TABLE public.events_discount_interactions
  ALTER COLUMN customer_cio_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS workspace     text,
  ADD COLUMN IF NOT EXISTS offer_partner text,
  ADD COLUMN IF NOT EXISTS offer_type    text;

ALTER TABLE public.events_competition_interactions
  ADD COLUMN IF NOT EXISTS workspace     text,
  ADD COLUMN IF NOT EXISTS offer_partner text,
  ADD COLUMN IF NOT EXISTS offer_type    text;

COMMENT ON COLUMN public.events_discount_interactions.workspace IS 'Brand the Customer.io event came from';
COMMENT ON COLUMN public.events_discount_interactions.offer_partner IS 'Sponsor or partner name from the Customer.io event';
COMMENT ON COLUMN public.events_discount_interactions.offer_type IS 'e.g. discount, voucher, event';

-- Both tables were readable by every signed-in member. They hold an email per
-- interaction (tens of thousands of rows on techtickets), so reads are admin
-- only. Writers are edge functions on the service role, which bypasses RLS.
DROP POLICY IF EXISTS "events_discount_interactions_select" ON public.events_discount_interactions;
CREATE POLICY "events_discount_interactions_select"
  ON public.events_discount_interactions FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "events_competition_interactions_select" ON public.events_competition_interactions;
CREATE POLICY "events_competition_interactions_select"
  ON public.events_competition_interactions FOR SELECT TO authenticated
  USING (public.is_admin());

-- Was WITH CHECK (true): any member could write fake competition interactions.
DROP POLICY IF EXISTS "events_competition_interactions_insert" ON public.events_competition_interactions;
CREATE POLICY "events_competition_interactions_insert"
  ON public.events_competition_interactions FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- ==========================================================================
-- 8. Portal RPCs
-- ==========================================================================
-- The portal hook (useDiscountCode) calls these three with
-- (p_user_email, p_event_id) and expects the original return shapes:
--   check  -> rows of (has_code, code)
--   issue  -> (success, code, message)
--
-- The originals trusted p_user_email from the browser, so an anonymous caller
-- could look up anyone's code, claim in someone else's name, or drain a pool
-- with made-up addresses. These answer only for the signed-in caller's own
-- email (auth.jwt() ->> 'email'); claiming already requires sign-in on the
-- portal. p_user_email is kept for signature compatibility and must match.
--
-- p_event_id accepts either the short text event id or the event uuid, and
-- also matches legacy_event_ref for historical codes.

DROP FUNCTION IF EXISTS public.events_check_user_existing_code(text, text);
CREATE FUNCTION public.events_check_user_existing_code(p_user_email text, p_event_id text)
RETURNS TABLE(has_code boolean, code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
BEGIN
  IF v_email = '' OR lower(trim(coalesce(p_user_email, ''))) <> v_email THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT true, dc.code
    FROM public.events_discount_codes dc
    LEFT JOIN public.events e ON e.id = dc.event_id
    WHERE dc.issued
      AND lower(dc.issued_to) = v_email
      AND (e.event_id = p_event_id
           OR dc.event_id::text = p_event_id
           OR dc.legacy_event_ref = p_event_id)
    ORDER BY dc.issued_at DESC NULLS LAST
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.events_get_available_codes_count(p_event_id text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)
  FROM public.events_discount_codes dc
  LEFT JOIN public.events e ON e.id = dc.event_id
  WHERE dc.issued = false
    AND dc.status = 'active'
    AND (e.event_id = p_event_id
         OR dc.event_id::text = p_event_id
         OR dc.legacy_event_ref = p_event_id);
$$;

DROP FUNCTION IF EXISTS public.events_issue_code_to_user(text, text);
CREATE FUNCTION public.events_issue_code_to_user(p_user_email text, p_event_id text)
RETURNS TABLE(success boolean, code text, message text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_existing text;
  v_id       uuid;
  v_code     text;
  v_discount uuid;
BEGIN
  IF v_email = '' OR lower(trim(coalesce(p_user_email, ''))) <> v_email THEN
    RETURN QUERY SELECT false, NULL::text, 'Sign in to claim a code';
    RETURN;
  END IF;

  SELECT dc.code INTO v_existing
  FROM public.events_discount_codes dc
  LEFT JOIN public.events e ON e.id = dc.event_id
  WHERE dc.issued
    AND lower(dc.issued_to) = v_email
    AND (e.event_id = p_event_id OR dc.event_id::text = p_event_id OR dc.legacy_event_ref = p_event_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT false, v_existing, 'User already has a code for this event';
    RETURN;
  END IF;

  -- Oldest unissued code, locked so two concurrent claims never get the same one.
  SELECT dc.id, dc.code, dc.discount_id INTO v_id, v_code, v_discount
  FROM public.events_discount_codes dc
  LEFT JOIN public.events e ON e.id = dc.event_id
  WHERE dc.issued = false
    AND dc.status = 'active'
    AND (e.event_id = p_event_id OR dc.event_id::text = p_event_id OR dc.legacy_event_ref = p_event_id)
  ORDER BY dc.created_at ASC
  LIMIT 1
  FOR UPDATE OF dc SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'No codes available - all claimed';
    RETURN;
  END IF;

  UPDATE public.events_discount_codes
     SET issued = true, issued_to = v_email, issued_at = now()
   WHERE id = v_id;

  -- Keep the claims record in step for pool discounts, which is what the
  -- admin event tab shows for them.
  IF v_discount IS NOT NULL THEN
    UPDATE public.events_discount_claims
       SET status = 'code-issued',
           code_issued_at = now(),
           accepted_at = coalesce(accepted_at, now())
     WHERE discount_id = v_discount AND lower(email) = v_email;
    IF NOT FOUND THEN
      INSERT INTO public.events_discount_claims
        (discount_id, email, status, accepted_at, code_issued_at)
      VALUES (v_discount, v_email, 'code-issued', now(), now());
    END IF;
  END IF;

  RETURN QUERY SELECT true, v_code, 'Code issued successfully';
END;
$$;

-- The portal shows "n of max claimed"; it previously counted issued rows
-- directly, which needed the public read policy removed in section 5.
CREATE OR REPLACE FUNCTION public.events_get_issued_codes_count(p_discount_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*) FROM public.events_discount_codes
  WHERE discount_id = p_discount_id AND issued = true;
$$;

REVOKE ALL ON FUNCTION public.events_check_user_existing_code(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.events_get_available_codes_count(text)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.events_issue_code_to_user(text, text)        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.events_get_issued_codes_count(uuid)          FROM PUBLIC;

-- Anonymous visitors can see availability. The check and issue functions are
-- also callable anonymously but answer only for a signed-in caller, which keeps
-- the portal's pre-sign-in code path from erroring.
GRANT EXECUTE ON FUNCTION public.events_check_user_existing_code(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.events_get_available_codes_count(text)       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.events_issue_code_to_user(text, text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.events_get_issued_codes_count(uuid)          TO anon, authenticated;
