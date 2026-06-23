-- Overall poll/vote results per poll block (newsletter Stats → Blocks).
-- Spec companion to the geo reports.
--
-- "What did people vote, overall?" — for hot_take / poll blocks, the per-option
-- click tally across the whole audience (no region breakdown, no k-anonymity:
-- aggregate totals don't identify individuals). Only real vote options are
-- counted, identified by the option number, NOT link_index:
--   * the tracked URL fragment `option-<N>` (real rendered hot_take links), or
--   * link_type `poll_option_<N>` / field `poll_option_<N>_link` (Puck convention).
-- The block's own section anchor (e.g. `#hot_take`, no option number) is excluded.
-- Option labels come from the block content's poll_option_<N>_label.
--
-- Down (for reference; not auto-run):
--   DROP FUNCTION IF EXISTS public.newsletter_poll_results(uuid[]);

DROP FUNCTION IF EXISTS public.newsletter_poll_results(uuid[]);
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
  -- edition_links that represent a vote option, with the option number resolved
  -- from the URL fragment / link_type / field (whichever carries it).
  opt_links AS (
    SELECT el.id AS edition_link_id, el.block_id,
      COALESCE(
        NULLIF((regexp_match(el.original_url, 'option-(\d+)'))[1], '')::int,
        NULLIF((regexp_match(el.link_type,   'poll_option_(\d+)'))[1], '')::int,
        NULLIF((regexp_match(el.field,       'poll_option_(\d+)'))[1], '')::int
      ) AS opt_n
    FROM public.newsletters_edition_links el
    JOIN poll_blocks pb ON pb.block_id = el.block_id
    WHERE el.original_url ~ 'option-\d+'
       OR el.link_type   ~ 'poll_option_\d+'
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
REVOKE EXECUTE ON FUNCTION public.newsletter_poll_results(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_poll_results(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.newsletter_poll_results(uuid[]) IS
  'Overall per-option vote tally for poll/hot_take blocks (no region; options by URL option-N / poll_option_N; section anchors excluded). Stats → Blocks.';
