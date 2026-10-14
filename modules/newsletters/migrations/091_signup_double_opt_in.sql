-- ============================================================================
-- 091_signup_double_opt_in
--
-- Public newsletter signup becomes double opt-in.
--
-- Until now `newsletter-signup` subscribed any address typed into the portal
-- form straight away, and its upsert set subscribed = true and cleared
-- unsubscribed_at on an existing row — so anyone could re-subscribe someone
-- who had unsubscribed. Now an anonymous signup only records a request here
-- and emails a confirmation link; the subscription is made when the owner of
-- the address confirms. Signed-in users subscribing one of their own verified
-- addresses still go straight through.
--
--   newsletters_signup_confirmations — one row per confirmation email sent.
--     The token is stored only as its SHA-256; the link carries the token.
--     The consent wording shown at signup is snapshotted with the request.
--
-- Also: the forms-module mapping trigger (042) had the same re-subscribe
-- upsert. It now only adds a subscription for an address the list has never
-- seen, and never touches an existing row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletters_signup_confirmations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email              text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  list_id            uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  collection_slug    text,
  -- The marketing-consent text shown beside the form when the request was made.
  consent_html       text,
  request_ip         text,
  request_user_agent text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  emailed_at         timestamptz,
  confirmed_at       timestamptz,
  confirm_ip         text
);

CREATE INDEX IF NOT EXISTS idx_nl_signup_conf_email_created
  ON public.newsletters_signup_confirmations (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nl_signup_conf_ip_created
  ON public.newsletters_signup_confirmations (request_ip, created_at DESC);

-- Service role only (the edge function). No browser role reads or writes it.
ALTER TABLE public.newsletters_signup_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletters_signup_confirmations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.newsletters_signup_confirmations TO service_role;

-- 042's forms mapping: never reactivate an existing (e.g. unsubscribed) row.
DO $$
BEGIN
  IF to_regclass('public.forms_submissions') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.newsletters_map_signup_submission()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE
      v_form_slug       text;
      v_collection_slug text;
      v_email           text;
      v_list_id         uuid;
    BEGIN
      SELECT slug INTO v_form_slug FROM public.forms WHERE id = NEW.form_id;
      IF v_form_slug IS NULL OR v_form_slug NOT LIKE 'newsletter-%signup' THEN
        RETURN NEW;
      END IF;

      v_collection_slug := NEW.responses->>'collection';
      v_email := lower(trim(NEW.responses->>'email'));
      IF v_collection_slug IS NULL OR v_email IS NULL OR v_email = '' THEN
        RETURN NEW;
      END IF;

      SELECT list_id INTO v_list_id
        FROM public.newsletters_template_collections WHERE slug = v_collection_slug;
      IF v_list_id IS NULL THEN
        RETURN NEW;
      END IF;

      -- An existing row is the subscriber's own decision (including an
      -- unsubscribe) and a form submission is not proof of who typed the
      -- address, so it is left exactly as it is.
      INSERT INTO public.list_subscriptions (list_id, person_id, email, subscribed, subscribed_at, source)
      VALUES (v_list_id, NEW.person_id, v_email, true, now(), 'newsletter-signup')
      ON CONFLICT (list_id, email) DO NOTHING;
      RETURN NEW;
    END;
    $fn$;
  END IF;
END $$;
