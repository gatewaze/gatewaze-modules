-- Multi-source bot-detection comparison for one edition (spec §C.2): per
-- detection_source, how many UNIQUE openers it calls human vs machine, plus a
-- "reconciled" count that rescues an MPP-classified open when the same recipient
-- has a genuine human CLICK (a click is far stronger evidence of a human than an
-- open). Compare against the trusted Customer.io aggregate in
-- newsletter_sends.metadata.cio_metrics.

CREATE OR REPLACE FUNCTION public.edition_detection_comparison(p_edition_id uuid)
RETURNS TABLE (
  detection_source         text,
  human_openers            bigint,
  machine_openers          bigint,
  human_clickers           bigint,
  reconciled_human_openers bigint,  -- human open OR human click (click-rescue)
  rescued_by_click         bigint,  -- reconciled − human_openers
  total_open_events        bigint,
  human_open_events        bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sends AS (
    SELECT id FROM public.newsletter_sends WHERE edition_id = p_edition_id
  ),
  per_recipient AS (
    SELECT e.email, c.detection_source,
      bool_or(c.is_human AND e.event_type = 'opened')   AS has_human_open,
      bool_or(e.event_type = 'opened')                   AS has_open,
      bool_or(c.is_human AND e.event_type = 'clicked')   AS has_human_click,
      count(*) FILTER (WHERE e.event_type = 'opened')                     AS open_events,
      count(*) FILTER (WHERE e.event_type = 'opened' AND c.is_human)      AS human_open_events
    FROM public.email_events e
    JOIN sends s ON e.newsletter_send_id = s.id
    JOIN public.email_event_classifications c ON c.event_id = e.id
    WHERE e.event_type IN ('opened', 'clicked')
    GROUP BY e.email, c.detection_source
  )
  SELECT detection_source,
    count(*) FILTER (WHERE has_human_open)                                          AS human_openers,
    count(*) FILTER (WHERE has_open AND NOT has_human_open)                         AS machine_openers,
    count(*) FILTER (WHERE has_human_click)                                         AS human_clickers,
    count(*) FILTER (WHERE has_open AND (has_human_open OR has_human_click))        AS reconciled_human_openers,
    count(*) FILTER (WHERE has_open AND NOT has_human_open AND has_human_click)     AS rescued_by_click,
    sum(open_events)                                                                AS total_open_events,
    sum(human_open_events)                                                          AS human_open_events
  FROM per_recipient
  GROUP BY detection_source;
$$;

GRANT EXECUTE ON FUNCTION public.edition_detection_comparison(uuid) TO authenticated;

COMMENT ON FUNCTION public.edition_detection_comparison(uuid) IS
  'Per-detection-source human/machine opener tallies + click-rescue reconciliation, for comparison against the Customer.io trusted aggregate (spec §C.2).';
