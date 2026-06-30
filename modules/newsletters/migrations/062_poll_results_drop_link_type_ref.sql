-- ============================================================================
-- Module: newsletters
-- Migration: 062_poll_results_drop_link_type_ref
-- Description: Stop referencing the legacy `link_type` column from
-- newsletter_poll_results.
--
-- Symptom: AAIF stats > Blocks tab returned
--   "Couldn't load this report. column el.link_type does not exist"
-- on every load.
--
-- Cause: migration 053 authored newsletter_poll_results to resolve a poll
-- option index from three fallbacks — original_url URL fragment, link_type
-- regex, field regex. Migration 032 (link_tracking) repurposed
-- newsletters_edition_links as the per-occurrence tracking registry and
-- relaxed link_type to nullable; on some installs (AAIF prod) the legacy
-- columns (link_type, short_path, short_url, distribution_channel, etc.)
-- were subsequently dropped out of band. PostgreSQL doesn't validate
-- plpgsql column references at CREATE time, so 053 applied silently — the
-- function only errored when first called (which happened only once a poll/
-- hot_take block existed AND someone opened the Poll Results panel).
--
-- Fix: drop the link_type fallback. The two remaining fallbacks
-- (original_url URL fragment `option-N`, and field regex `poll_option_N`)
-- cover every link the modern registry actually produces — registry rows
-- never set link_type, so the dropped branch was a no-op even on installs
-- that still have the column.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletter_poll_results(p_edition_ids uuid[])
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
    FROM public.newsletters_editions e WHERE e.id = ANY(p_edition_ids)
  ),
  poll_blocks AS (
    SELECT b.id AS block_id, b.edition_id, b.block_type, b.content
    FROM public.newsletters_edition_blocks b
    WHERE b.edition_id = ANY(p_edition_ids)
      AND b.block_type IN ('hot_take','poll','vote','survey')
  ),
  -- edition_links that represent a vote option, with the option number
  -- resolved from the URL fragment OR the field name (whichever carries it).
  opt_links AS (
    SELECT el.id AS edition_link_id, el.block_id,
      COALESCE(
        NULLIF((regexp_match(el.original_url, 'option-(\d+)'))[1], '')::int,
        NULLIF((regexp_match(el.field,        'poll_option_(\d+)'))[1], '')::int
      ) AS opt_n
    FROM public.newsletters_edition_links el
    JOIN poll_blocks pb ON pb.block_id = el.block_id
    WHERE el.original_url ~ 'option-\d+'
       OR el.field       ~ 'poll_option_\d+'
  ),
  clk AS (
    SELECT ol.block_id, ol.opt_n, count(DISTINCT ei.email_send_log_id) AS clicks
    FROM public.email_interactions ei
    JOIN opt_links ol ON ol.edition_link_id = ei.edition_link_id
    WHERE ei.edition_id = ANY(p_edition_ids)
      AND ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ol.opt_n IS NOT NULL
    GROUP BY ol.block_id, ol.opt_n
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'edition_id', pb.edition_id,
      'edition_date', e.edition_date,
      'edition_title', e.title,
      'block_id', pb.block_id,
      'block_type', pb.block_type,
      'option_index', clk.opt_n,
      'option_label', COALESCE(
        NULLIF(pb.content->>('poll_option_' || clk.opt_n || '_label'), ''),
        'Option ' || clk.opt_n),
      'clicks', clk.clicks
    ) AS j
    FROM clk
    JOIN poll_blocks pb ON pb.block_id = clk.block_id
    JOIN eds e ON e.edition_id = pb.edition_id
    ORDER BY e.edition_date DESC NULLS LAST, pb.block_id, clk.opt_n
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(clicks),0) FROM clk),
      'coverage_pct', 1.0,
      'suppressed_buckets', 0,
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
