-- ============================================================================
-- Module: discounts
-- Migration: 003_shared_offers
-- Description: Shared-code offers. One discount, one code that everyone gets,
--              valid for one or more events, each with its own registration
--              link, served from the portal's /offers/<slug> page.
--
-- Context: the existing flows hand each person a unique code from a pool
-- (events_issue_code_to_user) or mint one in Luma. A partner giveaway such as
-- "free tickets to PyTorch Conference and AGNTCon + MCPCon NA" instead has a
-- single code valid at both events. The page shows the offer on a GET and
-- only reveals the code, and records the claim, when the visitor clicks, so
-- email security scanners that open every link record nothing.
--
-- The shared code is kept in events_discount_secrets (admin-only) rather than
-- on events_discounts, which signed-in members can read. It is only handed
-- out through events_claim_shared_offer, which only the service role may call
-- (the portal's rate-limited /api/offers/<slug>/claim route).
-- ============================================================================

-- 1. Registration links: [{ "event_id": "<short event id>", "label": "...",
--    "url": "https://..." }]. url is optional; without it the portal uses the
--    event's own registration link.
ALTER TABLE public.events_discounts
  ADD COLUMN IF NOT EXISTS registration_links jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.events_discounts
  DROP CONSTRAINT IF EXISTS events_discounts_registration_links_array;
ALTER TABLE public.events_discounts
  ADD CONSTRAINT events_discounts_registration_links_array
    CHECK (jsonb_typeof(registration_links) = 'array' AND jsonb_array_length(registration_links) <= 20);

COMMENT ON COLUMN public.events_discounts.registration_links IS
  'Events this offer is valid for, as [{event_id, label?, url?}]. Shown as register buttons on /offers/<slug>.';

-- 2. The shared code itself.
ALTER TABLE public.events_discount_secrets
  ADD COLUMN IF NOT EXISTS shared_code text;

ALTER TABLE public.events_discount_secrets
  DROP CONSTRAINT IF EXISTS events_discount_secrets_shared_code_len;
ALTER TABLE public.events_discount_secrets
  ADD CONSTRAINT events_discount_secrets_shared_code_len
    CHECK (shared_code IS NULL OR char_length(shared_code) BETWEEN 1 AND 100);

COMMENT ON COLUMN public.events_discount_secrets.shared_code IS
  'One code given to everyone who claims this offer. Revealed only through events_claim_shared_offer.';

-- 3. The offer page is addressed by slug, so a slug may belong to one discount.
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_discounts_slug
  ON public.events_discounts (lower(slug))
  WHERE slug IS NOT NULL AND slug <> '';

-- 4. Claim: record who took the code and return it.
--    Returns status:
--      'claimed'     code returned, claim recorded
--      'not_found'   no such offer, or it has no shared code
--      'closed'      offer is not active or its close date has passed
--      'bad_email'   email missing or malformed
CREATE OR REPLACE FUNCTION public.events_claim_shared_offer(
  p_slug   text,
  p_email  text,
  p_source text DEFAULT NULL
)
RETURNS TABLE(status text, code text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_discount public.events_discounts%ROWTYPE;
  v_code     text;
  v_claim    uuid;
  v_status   text;
  v_now      timestamptz := now();
BEGIN
  SELECT d.* INTO v_discount
  FROM public.events_discounts d
  WHERE lower(d.slug) = lower(trim(coalesce(p_slug, '')))
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;

  SELECT s.shared_code INTO v_code
  FROM public.events_discount_secrets s
  WHERE s.discount_id = v_discount.id;

  IF v_code IS NULL OR v_code = '' THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;

  IF coalesce(v_discount.status, 'active') <> 'active'
     OR (v_discount.close_date IS NOT NULL AND v_discount.close_date < v_now) THEN
    RETURN QUERY SELECT 'closed'::text, NULL::text;
    RETURN;
  END IF;

  IF char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY SELECT 'bad_email'::text, NULL::text;
    RETURN;
  END IF;

  -- One claim row per person per offer, even under parallel clicks.
  PERFORM pg_advisory_xact_lock(hashtextextended('events_shared_offer:' || v_discount.id::text || '|' || v_email, 0));

  SELECT c.id, c.status INTO v_claim, v_status
  FROM public.events_discount_claims c
  WHERE c.discount_id = v_discount.id AND lower(c.email) = v_email
  ORDER BY c.created_at
  LIMIT 1;

  IF v_claim IS NULL THEN
    INSERT INTO public.events_discount_claims
      (discount_id, email, status, accepted_at, code_issued_at, claim_metadata)
    VALUES
      (v_discount.id, v_email, 'code-issued', v_now, v_now,
       jsonb_build_object('source', left(coalesce(p_source, 'offer-page'), 100)));
  ELSE
    -- Never step a claim backwards from a deposit state.
    UPDATE public.events_discount_claims c
       SET status         = CASE WHEN c.status IN ('deposit-initiated', 'deposit-paid') THEN c.status ELSE 'code-issued' END,
           accepted_at    = coalesce(c.accepted_at, v_now),
           code_issued_at = coalesce(c.code_issued_at, v_now)
     WHERE c.id = v_claim;
  END IF;

  RETURN QUERY SELECT 'claimed'::text, v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.events_claim_shared_offer(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.events_claim_shared_offer(text, text, text) TO service_role;
