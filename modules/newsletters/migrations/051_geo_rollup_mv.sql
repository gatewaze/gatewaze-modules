-- Newsletter Geo & Timezone Engagement Reporting — cross-edition rollup MV
-- Spec: gatewaze-environments/specs/spec-newsletter-geo-engagement-reporting.md (§7.6)
--
-- Country-level rollup keyed by (edition_id, region_level, region_code, metric),
-- backing multi-edition trend views. Per-edition R1–R5 read the live RPCs; only
-- cross-edition trends read this MV. Refreshed off-peak by the analytics cron via
-- newsletter_geo_rollup_refresh(). City level is intentionally excluded (payload).
--
-- Down (for reference; not auto-run):
--   DROP FUNCTION IF EXISTS public.newsletter_geo_rollup_refresh();
--   DROP MATERIALIZED VIEW IF EXISTS public.newsletter_geo_rollup;
--   DROP TABLE IF EXISTS public.newsletter_geo_rollup_meta;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.newsletter_geo_rollup AS
WITH sends AS (
  SELECT id AS send_id, edition_id FROM public.newsletter_sends
),
conf AS (
  SELECT COALESCE(max(open_human_confidence_min), 0.5) AS conf FROM public.newsletter_geo_config
),
delivered AS (  -- distinct delivered recipient per edition
  SELECT s.edition_id, lower(esl.recipient_email) AS email
  FROM public.email_send_log esl
  JOIN sends s ON s.send_id = esl.newsletter_send_id
  WHERE esl.delivered_at IS NOT NULL OR esl.status IN ('sent','delivered')
  GROUP BY s.edition_id, lower(esl.recipient_email)
),
ppl AS (
  SELECT lower(p.email) AS email, min(nullif(p.attributes->>'country','')) AS country
  FROM public.people p WHERE p.email IS NOT NULL GROUP BY lower(p.email)
),
metrics AS (SELECT unnest(ARRAY['open','click']) AS metric),
engaged AS (  -- distinct engaged recipient per edition per metric
  SELECT ei.edition_id, ei.event_type AS metric, lower(esl.recipient_email) AS email
  FROM public.email_interactions ei
  JOIN public.email_send_log esl ON esl.id = ei.email_send_log_id
  CROSS JOIN conf
  WHERE ei.is_bot IS NOT TRUE
    AND COALESCE(ei.consent_suppressed, false) = false
    AND ei.event_type IN ('open','click')
    AND (ei.event_type = 'click' OR ei.human_confidence >= conf.conf)
  GROUP BY ei.edition_id, ei.event_type, lower(esl.recipient_email)
),
ipc AS (  -- raw human events per edition/metric/IP-country
  SELECT ei.edition_id, ei.event_type AS metric, ei.ip_geo_country AS country, count(*) AS cnt
  FROM public.email_interactions ei
  CROSS JOIN conf
  WHERE ei.is_bot IS NOT TRUE
    AND COALESCE(ei.consent_suppressed, false) = false
    AND ei.event_type IN ('open','click')
    AND (ei.event_type = 'click' OR ei.human_confidence >= conf.conf)
    AND nullif(ei.ip_geo_country,'') IS NOT NULL
  GROUP BY ei.edition_id, ei.event_type, ei.ip_geo_country
),
grid AS (  -- edition × metric × profile-country present in delivered set
  SELECT DISTINCT d.edition_id, m.metric, pr.country
  FROM delivered d
  CROSS JOIN metrics m
  JOIN ppl pr ON pr.email = d.email AND pr.country IS NOT NULL
)
SELECT
  g.edition_id,
  'country'::text AS region_level,
  g.country       AS region_code,
  g.country       AS region_name,
  g.metric,
  count(DISTINCT d.email)                                   AS delivered_profile,
  count(DISTINCT e.email)                                   AS engaged_profile,
  COALESCE(max(ic.cnt), 0)                                  AS count_ip
FROM grid g
JOIN delivered d   ON d.edition_id = g.edition_id
JOIN ppl pr        ON pr.email = d.email AND pr.country = g.country
LEFT JOIN engaged e ON e.edition_id = g.edition_id AND e.metric = g.metric AND e.email = d.email
LEFT JOIN ipc ic   ON ic.edition_id = g.edition_id AND ic.metric = g.metric AND ic.country = g.country
GROUP BY g.edition_id, g.country, g.metric;

-- unique index required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_geo_rollup_key
  ON public.newsletter_geo_rollup (edition_id, region_level, region_code, metric);

GRANT SELECT ON public.newsletter_geo_rollup TO authenticated;

-- staleness marker (MVs are static snapshots; track refresh time separately)
CREATE TABLE IF NOT EXISTS public.newsletter_geo_rollup_meta (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_refreshed_at timestamptz
);
INSERT INTO public.newsletter_geo_rollup_meta (id, last_refreshed_at) VALUES (true, now())
ON CONFLICT (id) DO NOTHING;
GRANT SELECT ON public.newsletter_geo_rollup_meta TO authenticated;

CREATE OR REPLACE FUNCTION public.newsletter_geo_rollup_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '300s'
AS $fn$
BEGIN
  -- CONCURRENTLY needs a populated MV + unique index; fall back to plain on first run.
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.newsletter_geo_rollup;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW public.newsletter_geo_rollup;
  END;
  UPDATE public.newsletter_geo_rollup_meta SET last_refreshed_at = now() WHERE id;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_geo_rollup_refresh() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_geo_rollup_refresh() TO authenticated;
COMMENT ON FUNCTION public.newsletter_geo_rollup_refresh() IS
  'Refresh the cross-edition geo rollup MV (off-peak cron). Spec §7.6.';
