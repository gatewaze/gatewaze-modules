-- ============================================================================
-- Module: broadcasts
-- Migration: 018_broadcast_block_effectiveness
-- Description: Per-block click effectiveness for broadcasts — mirrors
-- newsletter_block_effectiveness (newsletters migration 052), keyed by
-- broadcast_id and grouped by block_type. Human clicks only (is_bot /
-- consent_suppressed filters). Per spec-broadcasts-blocks.md §5.5 / §9.
--
-- email_interactions has no broadcast_id column (spec §11 Q3 default: join, not
-- a new column), so interactions are attributed to a broadcast transitively via
-- email_send_log.broadcast_send_id → broadcast_sends.broadcast_id. The webhook
-- writes block_id/block_type onto the interaction when it resolves a broadcast
-- ?nlb= key against broadcast_links; this RPC rolls those up.
-- CTR denominator = distinct delivered recipients across the broadcast's sends.
-- ============================================================================

DROP FUNCTION IF EXISTS public.broadcast_block_effectiveness(uuid[]);
CREATE OR REPLACE FUNCTION public.broadcast_block_effectiveness(p_broadcast_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  WITH bcs AS (
    SELECT b.id AS broadcast_id, b.name, b.type
    FROM public.broadcasts b
    WHERE b.id = ANY(p_broadcast_ids)
  ),
  sends AS (
    SELECT s.id AS send_id, s.broadcast_id
    FROM public.broadcast_sends s
    WHERE s.broadcast_id = ANY(p_broadcast_ids)
  ),
  -- distinct delivered recipients per broadcast (CTR denominator)
  delivered AS (
    SELECT s.broadcast_id, count(DISTINCT lower(esl.recipient_email)) AS delivered
    FROM public.email_send_log esl
    JOIN sends s ON s.send_id = esl.broadcast_send_id
    WHERE esl.delivered_at IS NOT NULL OR esl.status IN ('sent','delivered')
    GROUP BY s.broadcast_id
  ),
  -- human clicks per (broadcast, block_type), attributed via the send log
  blk AS (
    SELECT s.broadcast_id, ei.block_type,
           count(DISTINCT ei.email_send_log_id) AS clickers,
           count(*) AS events
    FROM public.email_interactions ei
    JOIN public.email_send_log esl ON esl.id = ei.email_send_log_id
    JOIN sends s ON s.send_id = esl.broadcast_send_id
    WHERE ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.block_type IS NOT NULL
    GROUP BY s.broadcast_id, ei.block_type
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'broadcast_id', b.broadcast_id,
      'broadcast_name', c.name,
      'broadcast_type', c.type,
      'block_type', b.block_type,
      'clickers', b.clickers,
      'events', b.events,
      'delivered', COALESCE(d.delivered, 0),
      'ctr', CASE WHEN COALESCE(d.delivered, 0) > 0
                  THEN round(b.clickers::numeric / d.delivered, 4) END
    ) AS j
    FROM blk b
    JOIN bcs c ON c.broadcast_id = b.broadcast_id
    LEFT JOIN delivered d ON d.broadcast_id = b.broadcast_id
    ORDER BY c.name NULLS LAST, b.block_type
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(events), 0) FROM blk),
      'coverage_pct', 1.0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.broadcast_block_effectiveness(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_block_effectiveness(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_block_effectiveness(uuid[]) IS
  'Per-block human click effectiveness per broadcast, grouped by block_type; attributed via email_send_log.broadcast_send_id. Mirrors newsletter_block_effectiveness. Per spec-broadcasts-blocks §5.5.';
