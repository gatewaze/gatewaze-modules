-- List hygiene: suppress dead/stale subscribers so they stop receiving sends
-- and stop inflating the list. Two criteria (spec-discussed):
--   1. Repeat bounces — an address that bounced in >= p_min_bounce_editions
--      distinct sends is a confirmed-dead address (a transient/soft bounce
--      won't recur across that many editions). Email-level, so it suppresses
--      the address on the scoped list(s) wherever still subscribed.
--   2. Inactivity — subscribed longer than p_inactive_months ago AND no open
--      or click in that window. Opens are MPP-noisy, but that only makes this
--      LENIENT (an MPP open counts as activity → fewer removed), which is the
--      safe direction for a destructive-ish op.
--
-- Suppression = set subscribed=false (NOT delete): the send path filters
-- subscribed=true, so they're immediately excluded; the row stays for audit
-- and to stop a future re-import/re-subscribe silently re-adding them.
--
-- Idempotent (only touches subscribed=true rows) and dry-runnable
-- (p_dry_run=true → returns the counts it WOULD suppress, changes nothing).
-- Returns one row per reason + a total.
CREATE OR REPLACE FUNCTION public.suppress_stale_list_subscribers(
  p_list_id              uuid    DEFAULT NULL,   -- NULL = all lists
  p_min_bounce_editions  integer DEFAULT 4,
  p_inactive_months      integer DEFAULT 6,
  p_suppress_inactive    boolean DEFAULT true,
  p_dry_run              boolean DEFAULT true
)
RETURNS TABLE (reason text, affected bigint)
LANGUAGE plpgsql
SET statement_timeout = '180s'
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(months => p_inactive_months);
BEGIN
  RETURN QUERY
  WITH subs AS (
    SELECT ls.list_id, lower(ls.email) AS email, ls.subscribed_at
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = true
      AND (p_list_id IS NULL OR ls.list_id = p_list_id)
  ),
  bounce AS (
    SELECT lower(recipient_email) AS email
    FROM public.email_send_log
    WHERE status = 'bounced'
    GROUP BY 1
    HAVING count(DISTINCT newsletter_send_id) >= p_min_bounce_editions
  ),
  engaged AS (
    SELECT email, max(ts) AS last_at FROM (
      SELECT lower(recipient_email) AS email, greatest(first_opened_at, first_clicked_at) AS ts
        FROM public.email_send_log
        WHERE first_opened_at IS NOT NULL OR first_clicked_at IS NOT NULL
      UNION ALL
      SELECT lower(recipient_email), greatest(last_open, last_click)
        FROM public.cio_recipient_engagement
    ) x WHERE ts IS NOT NULL GROUP BY 1
  ),
  candidates AS (
    SELECT s.list_id, s.email,
      (b.email IS NOT NULL) AS is_bounced,
      (p_suppress_inactive
        AND s.subscribed_at IS NOT NULL AND s.subscribed_at < v_cutoff
        AND coalesce(e.last_at, '-infinity'::timestamptz) < v_cutoff) AS is_inactive
    FROM subs s
    LEFT JOIN bounce b ON b.email = s.email
    LEFT JOIN engaged e ON e.email = s.email
  ),
  to_suppress AS (
    SELECT * FROM candidates WHERE is_bounced OR is_inactive
  ),
  -- Data-modifying CTE: Postgres always runs this to completion. The
  -- `NOT p_dry_run` guard makes it a no-op in dry-run mode.
  applied AS (
    UPDATE public.list_subscriptions ls
    SET subscribed = false,
        unsubscribed_at = coalesce(ls.unsubscribed_at, now()),
        source = CASE WHEN c.is_bounced THEN 'list-hygiene:bounce' ELSE 'list-hygiene:inactive' END,
        updated_at = now()
    FROM to_suppress c
    WHERE NOT p_dry_run
      AND ls.list_id = c.list_id
      AND lower(ls.email) = c.email
      AND ls.subscribed = true
    RETURNING 1
  )
  SELECT 'bounced'::text, count(*) FROM to_suppress WHERE is_bounced
  UNION ALL
  SELECT 'inactive', count(*) FROM to_suppress WHERE is_inactive AND NOT is_bounced
  UNION ALL
  SELECT CASE WHEN p_dry_run THEN 'would_suppress_total' ELSE 'suppressed_total' END,
         (SELECT count(*) FROM to_suppress)
  UNION ALL
  -- Force `applied` to be referenced so the planner can't skip it (belt &
  -- braces; wCTEs run regardless, but this keeps intent explicit).
  SELECT 'applied_rows', (SELECT count(*) FROM applied);
END $$;

COMMENT ON FUNCTION public.suppress_stale_list_subscribers(uuid, integer, integer, boolean, boolean) IS
  'List hygiene: suppress (subscribed=false) repeat-bouncers (>= p_min_bounce_editions sends) and inactive (no open/click in p_inactive_months) subscribers on a list (or all lists). p_dry_run=true reports counts without changing data. Idempotent.';
