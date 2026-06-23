-- ============================================================================
-- Module: newsletters
-- Migration: 055_recipient_preview_count
-- Description: Live "this send will go to N recipients" indicator for the
-- sending UI. Counts deliverable recipients for a list, applying the same
-- already-sent exclusion the fanout uses (so the number reacts to the
-- "exclude already-sent" checkboxes). A naive (list_size − prior sent_count)
-- subtraction is wrong — prior sends may target larger/other lists — so this
-- computes the real overlap. is_admin()-gated SECURITY DEFINER.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletter_recipient_preview_count(
  p_list_id uuid,
  p_exclude_send_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN (
    SELECT count(*)::int
    FROM public.list_subscriptions ls
    WHERE ls.list_id = p_list_id
      AND ls.subscribed = true
      AND (
        p_exclude_send_ids IS NULL
        OR array_length(p_exclude_send_ids, 1) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.email_send_log esl
          WHERE esl.newsletter_send_id = ANY (p_exclude_send_ids)
            AND esl.sent_at IS NOT NULL
            AND lower(esl.recipient_email) = lower(ls.email)
        )
      )
  );
END;
$function$;
