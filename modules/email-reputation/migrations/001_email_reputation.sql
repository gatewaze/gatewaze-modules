-- ============================================================================
-- Module: email-reputation
-- Migration: 001_email_reputation
-- Description: phase 1 of spec-email-reputation-module.md. Per-send open rates
-- by mailbox provider, and an alert when one provider falls far below the
-- others. Gmail accepting mail and then filing it as spam shows up as a Gmail
-- open rate near 2% while other providers sit near 30% (AAIF from 27 Aug
-- 2026); this makes that visible from the first send.
--
-- Read-only over email_send_log, newsletter_sends and broadcast_sends. Nothing
-- here changes who receives a send.
-- ============================================================================

-- Recipient domain -> mailbox provider, from the domain's MX records (looked up
-- by the worker). Google Workspace addresses on company domains get Gmail's
-- filtering, so the provider comes from MX, not from the address.
CREATE TABLE IF NOT EXISTS public.email_reputation_domain_providers (
  domain      text PRIMARY KEY,
  provider    text NOT NULL CHECK (provider IN ('google', 'microsoft', 'yahoo', 'apple', 'other', 'unknown')),
  mx_host     text,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  error       text
);

-- One row per send the module has measured.
CREATE TABLE IF NOT EXISTS public.email_reputation_sends (
  send_kind        text NOT NULL CHECK (send_kind IN ('newsletter', 'broadcast')),
  send_id          uuid NOT NULL,
  sending_domain   text,
  send_label       text,
  send_started_at  timestamptz,
  computed_at      timestamptz,
  evaluated_at     timestamptz,
  PRIMARY KEY (send_kind, send_id)
);
CREATE INDEX IF NOT EXISTS idx_email_reputation_sends_domain_started
  ON public.email_reputation_sends (sending_domain, send_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_reputation_sends_unevaluated
  ON public.email_reputation_sends (send_started_at) WHERE evaluated_at IS NULL;

-- Counts per send and provider.
CREATE TABLE IF NOT EXISTS public.email_reputation_send_stats (
  send_kind   text NOT NULL,
  send_id     uuid NOT NULL,
  provider    text NOT NULL,
  recipients  integer NOT NULL DEFAULT 0,
  delivered   integer NOT NULL DEFAULT 0,
  opened      integer NOT NULL DEFAULT 0,
  clicked     integer NOT NULL DEFAULT 0,
  bounced     integer NOT NULL DEFAULT 0,
  deferred    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (send_kind, send_id, provider),
  FOREIGN KEY (send_kind, send_id) REFERENCES public.email_reputation_sends (send_kind, send_id) ON DELETE CASCADE
);

-- A provider whose open rate fell far below the others on one send.
CREATE TABLE IF NOT EXISTS public.email_reputation_alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_kind           text NOT NULL,
  send_id             uuid NOT NULL,
  provider            text NOT NULL,
  sending_domain      text,
  provider_open_rate  numeric NOT NULL,
  baseline_open_rate  numeric NOT NULL,
  delivered           integer NOT NULL,
  notified_at         timestamptz,
  acknowledged_at     timestamptz,
  acknowledged_by     uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (send_kind, send_id, provider),
  FOREIGN KEY (send_kind, send_id) REFERENCES public.email_reputation_sends (send_kind, send_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_reputation_alerts_open
  ON public.email_reputation_alerts (created_at DESC) WHERE acknowledged_at IS NULL;

-- Admins read; only the service role (which bypasses RLS) writes. Acknowledging
-- an alert goes through the RPC below.
ALTER TABLE public.email_reputation_domain_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_reputation_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_reputation_send_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_reputation_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_reputation_domain_providers_admin_read ON public.email_reputation_domain_providers;
CREATE POLICY email_reputation_domain_providers_admin_read ON public.email_reputation_domain_providers
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_reputation_sends_admin_read ON public.email_reputation_sends;
CREATE POLICY email_reputation_sends_admin_read ON public.email_reputation_sends
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_reputation_send_stats_admin_read ON public.email_reputation_send_stats;
CREATE POLICY email_reputation_send_stats_admin_read ON public.email_reputation_send_stats
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_reputation_alerts_admin_read ON public.email_reputation_alerts;
CREATE POLICY email_reputation_alerts_admin_read ON public.email_reputation_alerts
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Supabase's default privileges give anon and authenticated ALL on new tables;
-- RLS covers INSERT/UPDATE/DELETE but not TRUNCATE, REFERENCES or TRIGGER.
REVOKE ALL ON public.email_reputation_domain_providers, public.email_reputation_sends,
  public.email_reputation_send_stats, public.email_reputation_alerts FROM anon, authenticated;
GRANT SELECT ON public.email_reputation_domain_providers, public.email_reputation_sends,
  public.email_reputation_send_stats, public.email_reputation_alerts TO authenticated;
GRANT ALL ON public.email_reputation_domain_providers, public.email_reputation_sends,
  public.email_reputation_send_stats, public.email_reputation_alerts TO service_role;

-- Provider for well-known consumer domains, used until a domain's MX lookup has
-- run. Everything else is 'unknown' until looked up.
CREATE OR REPLACE FUNCTION public.email_reputation_known_provider(p_domain text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_domain IN ('gmail.com', 'googlemail.com') THEN 'google'
    WHEN p_domain IN ('outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'outlook.co.uk', 'live.co.uk') THEN 'microsoft'
    WHEN p_domain IN ('yahoo.com', 'ymail.com', 'aol.com', 'yahoo.co.uk', 'yahoo.co.in', 'rocketmail.com') THEN 'yahoo'
    WHEN p_domain IN ('icloud.com', 'me.com', 'mac.com') THEN 'apple'
    ELSE 'unknown'
  END
$$;

-- Aggregate one send's email_send_log rows by provider and store the counts.
-- Replaces the send's previous counts, because providers move from 'unknown'
-- to a real value as MX lookups complete.
CREATE OR REPLACE FUNCTION public.email_reputation_compute_send(p_kind text, p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_from text; v_label text; v_started timestamptz; v_rows integer := 0;
BEGIN
  IF p_kind NOT IN ('newsletter', 'broadcast') THEN
    RAISE EXCEPTION 'unknown send kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_kind = 'newsletter' THEN
    SELECT s.from_address, s.subject, COALESCE(s.started_at, s.scheduled_at, s.created_at)
      INTO v_from, v_label, v_started
    FROM public.newsletter_sends s WHERE s.id = p_send_id;
  ELSE
    EXECUTE 'SELECT s.from_address, COALESCE(s.subject, s.name), COALESCE(s.started_at, s.scheduled_at, s.created_at)
             FROM public.broadcast_sends s WHERE s.id = $1'
      INTO v_from, v_label, v_started USING p_send_id;
  END IF;
  IF v_started IS NULL THEN RETURN 0; END IF;

  INSERT INTO public.email_reputation_sends (send_kind, send_id, sending_domain, send_label, send_started_at, computed_at)
  VALUES (p_kind, p_send_id, nullif(lower(split_part(coalesce(v_from, ''), '@', 2)), ''), left(v_label, 300), v_started, now())
  ON CONFLICT (send_kind, send_id) DO UPDATE
    SET sending_domain = EXCLUDED.sending_domain, send_label = EXCLUDED.send_label,
        send_started_at = EXCLUDED.send_started_at, computed_at = now();

  DELETE FROM public.email_reputation_send_stats WHERE send_kind = p_kind AND send_id = p_send_id;

  EXECUTE format($q$
    INSERT INTO public.email_reputation_send_stats (send_kind, send_id, provider, recipients, delivered, opened, clicked, bounced, deferred)
    SELECT $1, $2, COALESCE(dp.provider, public.email_reputation_known_provider(l.dom)),
           count(*), count(l.delivered_at), count(l.first_opened_at), count(l.first_clicked_at),
           count(l.bounced_at), count(l.deferred_at)
    FROM (
      SELECT lower(split_part(e.recipient_email, '@', 2)) AS dom,
             e.delivered_at, e.first_opened_at, e.first_clicked_at, e.bounced_at, e.deferred_at
      FROM public.email_send_log e
      WHERE e.%I = $2
    ) l
    LEFT JOIN public.email_reputation_domain_providers dp ON dp.domain = l.dom
    GROUP BY 3
  $q$, p_kind || '_send_id')
  USING p_kind, p_send_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- Sends due for (re)computing: anything started within the backfill window that
-- has never been measured, recent sends every run, and older sends once a day so
-- newly resolved domains reach their counts. Newest first.
CREATE OR REPLACE FUNCTION public.email_reputation_due_sends(p_recent_days integer, p_backfill_days integer, p_limit integer)
RETURNS TABLE (send_kind text, send_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sql text;
BEGIN
  v_sql := $q$
    SELECT 'newsletter'::text AS kind, s.id, COALESCE(s.started_at, s.scheduled_at, s.created_at) AS started
    FROM public.newsletter_sends s
    WHERE s.status IN ('sending', 'sent', 'completed')
      AND COALESCE(s.started_at, s.scheduled_at, s.created_at) > now() - make_interval(days => $2)
  $q$;
  IF to_regclass('public.broadcast_sends') IS NOT NULL THEN
    v_sql := v_sql || $q$
      UNION ALL
      SELECT 'broadcast'::text, s.id, COALESCE(s.started_at, s.scheduled_at, s.created_at)
      FROM public.broadcast_sends s
      WHERE s.status IN ('sending', 'sent', 'completed')
        AND COALESCE(s.started_at, s.scheduled_at, s.created_at) > now() - make_interval(days => $2)
    $q$;
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT c.kind, c.id FROM (%s) c
    LEFT JOIN public.email_reputation_sends r ON r.send_kind = c.kind AND r.send_id = c.id
    WHERE r.computed_at IS NULL
       OR (c.started > now() - make_interval(days => $1) AND r.computed_at < now() - interval '25 minutes')
       OR r.computed_at < now() - interval '24 hours'
    ORDER BY (r.computed_at IS NULL) DESC, c.started DESC
    LIMIT $3
  $q$, v_sql)
  USING p_recent_days, p_backfill_days, p_limit;
END $$;

-- Recipient domains in measured sends that have no provider yet and are not a
-- known consumer domain, or whose lookup is over 30 days old. Most common first.
CREATE OR REPLACE FUNCTION public.email_reputation_unresolved_domains(p_days integer, p_limit integer)
RETURNS TABLE (domain text, recipients bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH recent AS (
    SELECT r.send_kind, r.send_id FROM public.email_reputation_sends r
    WHERE r.send_started_at > now() - make_interval(days => p_days)
    ORDER BY r.send_started_at DESC LIMIT 20
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

-- Acknowledge an alert. Admins only.
CREATE OR REPLACE FUNCTION public.email_reputation_acknowledge_alert(p_alert_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.email_reputation_alerts
     SET acknowledged_at = now(), acknowledged_by = auth.uid()
   WHERE id = p_alert_id AND acknowledged_at IS NULL;
END $$;

REVOKE ALL ON FUNCTION public.email_reputation_compute_send(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_reputation_due_sends(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_reputation_acknowledge_alert(uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.email_reputation_compute_send(text, uuid) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.email_reputation_due_sends(integer, integer, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.email_reputation_acknowledge_alert(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.email_reputation_compute_send(text, uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION public.email_reputation_due_sends(integer, integer, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.email_reputation_unresolved_domains(integer, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.email_reputation_acknowledge_alert(uuid) TO authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
