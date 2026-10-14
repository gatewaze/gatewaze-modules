-- ============================================================================
-- Module: email-reputation
-- Migration: 002_unresolved_domains_recent_three
-- Description: email_reputation_unresolved_domains scanned the recipients of
-- the 20 most recent measured sends. On AAIF prod that is about 1.2 million
-- email_send_log rows, which ran past the 8s PostgREST statement timeout once
-- the first worker run had registered 48 sends (the one-send test passed).
-- Weekly sends repeat nearly the same recipient domains, so the 3 most recent
-- sends cover what needs looking up (about 175k rows, under 2s).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.email_reputation_unresolved_domains(p_days integer, p_limit integer)
RETURNS TABLE (domain text, recipients bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH recent AS (
    SELECT r.send_kind, r.send_id FROM public.email_reputation_sends r
    WHERE r.send_started_at > now() - make_interval(days => p_days)
    ORDER BY r.send_started_at DESC LIMIT 3
  ), doms AS (
    SELECT lower(split_part(e.recipient_email, '@', 2)) AS dom
    FROM public.email_send_log e JOIN recent r ON r.send_kind = 'newsletter' AND e.newsletter_send_id = r.send_id
    UNION ALL
    SELECT lower(split_part(e.recipient_email, '@', 2))
    FROM public.email_send_log e JOIN recent r ON r.send_kind = 'broadcast' AND e.broadcast_send_id = r.send_id
  )
  SELECT d.dom, count(*)
  FROM doms d
  LEFT JOIN public.email_reputation_domain_providers p ON p.domain = d.dom
  WHERE d.dom <> '' AND d.dom ~ '^[a-z0-9.-]+\.[a-z]{2,}$'
    AND public.email_reputation_known_provider(d.dom) = 'unknown'
    AND (p.domain IS NULL OR p.checked_at < now() - interval '30 days')
  GROUP BY d.dom
  ORDER BY count(*) DESC
  LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
