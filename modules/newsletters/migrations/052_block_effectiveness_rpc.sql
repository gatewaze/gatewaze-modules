-- Cross-edition block effectiveness over time (newsletter Stats → Blocks).
-- Spec: spec-newsletter-geo-engagement-reporting (block reporting companion).
--
-- "How well does each block type generate clicks, edition over edition?"
-- Aggregates human clicks by block_type per edition across a newsletter's
-- editions (block_type is the cross-edition lineage key — block instances differ
-- per edition). Bot/consent filtered; no geo, so no k-anonymity needed.
-- LANGUAGE plpgsql STABLE SECURITY DEFINER, returns jsonb {data, meta}.
--
-- Down (for reference; not auto-run):
--   DROP FUNCTION IF EXISTS public.newsletter_block_effectiveness(uuid[]);

DROP FUNCTION IF EXISTS public.newsletter_block_effectiveness(uuid[]);
CREATE OR REPLACE FUNCTION public.newsletter_block_effectiveness(p_edition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  WITH eds AS (
    SELECT e.id AS edition_id, e.edition_date, e.title
    FROM public.newsletters_editions e
    WHERE e.id = ANY(p_edition_ids)
  ),
  sends AS (
    SELECT s.id AS send_id, s.edition_id
    FROM public.newsletter_sends s WHERE s.edition_id = ANY(p_edition_ids)
  ),
  delivered AS (  -- distinct delivered recipients per edition (CTR denominator)
    SELECT s.edition_id, count(DISTINCT lower(esl.recipient_email)) AS delivered
    FROM public.email_send_log esl
    JOIN sends s ON s.send_id = esl.newsletter_send_id
    WHERE esl.delivered_at IS NOT NULL OR esl.status IN ('sent','delivered')
    GROUP BY s.edition_id
  ),
  blk AS (  -- human clicks per (edition, block_type)
    SELECT ei.edition_id, ei.block_type,
           count(DISTINCT ei.email_send_log_id) AS clickers,
           count(*) AS events
    FROM public.email_interactions ei
    WHERE ei.edition_id = ANY(p_edition_ids)
      AND ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.block_type IS NOT NULL
    GROUP BY ei.edition_id, ei.block_type
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'edition_id', b.edition_id,
      'edition_date', e.edition_date,
      'edition_title', e.title,
      'block_type', b.block_type,
      'clickers', b.clickers,
      'events', b.events,
      'delivered', COALESCE(d.delivered, 0),
      'ctr', CASE WHEN COALESCE(d.delivered, 0) > 0
                  THEN round(b.clickers::numeric / d.delivered, 4) END
    ) AS j
    FROM blk b
    JOIN eds e ON e.edition_id = b.edition_id
    LEFT JOIN delivered d ON d.edition_id = b.edition_id
    ORDER BY e.edition_date NULLS LAST, b.block_type
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(events), 0) FROM blk),
      'coverage_pct', 1.0,
      'suppressed_buckets', 0,
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_block_effectiveness(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_block_effectiveness(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.newsletter_block_effectiveness(uuid[]) IS
  'Cross-edition block effectiveness: human clickers/CTR per block_type per edition. Stats → Blocks.';
