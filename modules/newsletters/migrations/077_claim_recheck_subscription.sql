-- Re-check subscription state at drip-claim time.
--
-- Fan-out snapshots the recipient set once (list_subscriptions.subscribed =
-- true at fan-out). For tz_local sends the drip then runs for up to ~24h, and
-- until now nothing re-checked the flag — someone who unsubscribed after
-- fan-out but before their local send window still got the email (observed:
-- 1 recipient on the 2026-07-30 send).
--
-- Fix: at claim time, any due 'pending' recipient whose address is now
-- unsubscribed from one of the send's lists is marked 'skipped' (with
-- last_error explaining why) instead of being claimed. The lookup rides the
-- partial index idx_list_subscriptions_lower_email (lower(email) WHERE
-- subscribed = false), so the common all-subscribed case costs one probe per
-- claimed row.
--
-- Otherwise identical to the 044 definition (pause/exclude semantics kept).

CREATE OR REPLACE FUNCTION public.claim_due_newsletter_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.newsletter_send_recipients
LANGUAGE sql
AS $$
  WITH skip_unsubscribed AS (
    UPDATE public.newsletter_send_recipients r
    SET status = 'skipped',
        last_error = 'unsubscribed after fan-out',
        updated_at = now()
    FROM (
      SELECT nsr.id
      FROM public.newsletter_send_recipients nsr
      JOIN public.newsletter_sends s ON s.id = nsr.send_id
      WHERE nsr.status = 'pending'
        AND nsr.send_at <= now()
        AND s.status = 'sending'
        AND EXISTS (
          SELECT 1 FROM public.list_subscriptions ls
          WHERE lower(ls.email) = lower(nsr.email)
            AND ls.subscribed = false
            AND ls.list_id::text = ANY (s.list_ids)
        )
      FOR UPDATE OF nsr SKIP LOCKED
    ) unsubbed
    WHERE r.id = unsubbed.id
  )
  UPDATE public.newsletter_send_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT nsr.id
    FROM public.newsletter_send_recipients nsr
    JOIN public.newsletter_sends s ON s.id = nsr.send_id
    WHERE nsr.status = 'pending'
      AND nsr.send_at <= now()
      AND s.status = 'sending'
      -- Same-snapshot twin of skip_unsubscribed: never claim a row that the
      -- CTE is skipping this tick.
      AND NOT EXISTS (
        SELECT 1 FROM public.list_subscriptions ls
        WHERE lower(ls.email) = lower(nsr.email)
          AND ls.subscribed = false
          AND ls.list_id::text = ANY (s.list_ids)
      )
    ORDER BY nsr.send_at
    LIMIT p_limit
    FOR UPDATE OF nsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;
