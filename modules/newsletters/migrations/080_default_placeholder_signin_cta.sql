-- ============================================================================
-- newsletters — point the default members-only placeholder CTA at sign-in
-- ============================================================================
-- 079 shipped the default placeholder with an "About membership" CTA to
-- /members. Per product decision the CTA should instead send a logged-out
-- member to sign-in, so they can authenticate with their member email and
-- unlock the gated section in place. cta_url is stored RELATIVE (/sign-in) —
-- the portal web view links to it directly; the email send path prefixes the
-- portal base URL. A block that sets its own placeholder still overrides this.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletters_default_block_placeholder()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'title',     'Members only',
    'body',      'This section is for AAIF member organizations. Sign in with your member email to read it.',
    'cta_label', 'Sign in to read',
    'cta_url',   '/sign-in'
  );
$$;
GRANT EXECUTE ON FUNCTION public.newsletters_default_block_placeholder()
  TO anon, authenticated, service_role;
