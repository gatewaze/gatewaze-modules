-- ============================================================================
-- Module: broadcasts
-- Migration: 007_broadcast_recipient_preview_count
-- Description: Deliverable-count preview for the shared SendingPanel's "Send to
-- N recipients" indicator. Mirrors fanout_broadcast_send_recipients' audience
-- resolution EXACTLY (segment membership OR contact lists, suppression filter,
-- prior-send exclusion) but only COUNTs — so the indicator reflects the real
-- overlap after exclusions rather than a naive subtraction. Dedupes by email
-- (fan-out is ON CONFLICT (send_id, email) DO NOTHING).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_recipient_preview_count(
  p_audience_type     text,
  p_segment_id        uuid,
  p_list_ids          uuid[],
  p_suppression_topic text   DEFAULT 'broadcasts',
  p_exclude_send_ids  uuid[] DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH aud AS (
    -- Segment source (matches fanout's segments_memberships path).
    SELECT pp.email AS email
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE p_audience_type = 'segment'
      AND p_segment_id IS NOT NULL
      AND sm.segment_id = p_segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    -- Contact-list source.
    SELECT ls.email AS email
    FROM public.list_subscriptions ls
    WHERE p_audience_type = 'list'
      AND COALESCE(array_length(p_list_ids, 1), 0) > 0
      AND ls.list_id = ANY (p_list_ids)
      AND ls.subscribed = true
      AND ls.email IS NOT NULL AND ls.email <> ''
  )
  SELECT COUNT(DISTINCT lower(aud.email))::integer
  FROM aud
  WHERE
    -- Suppression filter (compliance-critical) — same predicate as fan-out.
    NOT EXISTS (
      SELECT 1 FROM public.broadcast_suppressions s
      WHERE lower(s.email) = lower(aud.email)
        AND (s.topic = p_suppression_topic OR s.topic = 'all')
    )
    -- Prior-send exclusion: drop anyone already emailed by an excluded send.
    AND (
      p_exclude_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.broadcast_send_id = ANY (p_exclude_send_ids)
          AND esl.sent_at IS NOT NULL
          AND lower(esl.recipient_email) = lower(aud.email)
      )
    );
$fn$;

COMMENT ON FUNCTION public.broadcast_recipient_preview_count(text, uuid, uuid[], text, uuid[]) IS
  'Deliverable recipient count for a broadcast audience (segment or lists) after suppression + prior-send exclusion. Mirrors fanout_broadcast_send_recipients. Used by the shared SendingPanel send indicator.';
