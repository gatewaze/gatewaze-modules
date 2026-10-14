-- ============================================================================
-- Module: segments
-- Migration: 018_email_engagement_indexes
-- Description: email engagement conditions ("Sent / Not sent / Opened /
-- Clicked <broadcast or edition>") compile to an EXISTS over email_send_log
-- matching lower(recipient_email) = lower(p.email) for one broadcast's or
-- edition's sends. Nothing indexed lower(recipient_email), so whenever the
-- planner checked that per person it scanned the whole send each time.
--
-- That is exactly the plan segments_calculate_members_batch gets: it pages
-- people in id order with a LIMIT inside an INSERT (no parallelism), so each
-- condition becomes a per-row nested-loop anti-join. On tech.tickets an
-- audience of "Not sent <broadcast> AND within 500 km of <place>" took 39s
-- per page against the 8s PostgREST statement timeout, so saving it failed
-- (57014). With this index the same plan takes 0.47s.
--
-- Large tables: CREATE INDEX (not CONCURRENTLY, which cannot run inside the
-- migration's transaction) blocks writes to email_send_log while it builds,
-- and on a multi-million-row table would also exceed the runner's statement
-- timeout. So each index is built here only when the table is small; on a
-- large installation this logs a NOTICE and skips, and the index must be built
-- by hand with the CONCURRENTLY form in the NOTICE (done for AAIF prod).
-- ============================================================================
DO $$
DECLARE
  v_rows bigint;
  v_small boolean;
BEGIN
  IF to_regclass('public.email_send_log') IS NULL THEN RETURN; END IF;

  SELECT GREATEST(reltuples, 0)::bigint INTO v_rows FROM pg_class WHERE oid = 'public.email_send_log'::regclass;
  v_small := v_rows < 500000;

  IF to_regclass('public.idx_esl_broadcast_send_lower_recipient') IS NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_send_log' AND column_name = 'broadcast_send_id') THEN
    IF v_small THEN
      CREATE INDEX idx_esl_broadcast_send_lower_recipient
        ON public.email_send_log (broadcast_send_id, lower(recipient_email))
        WHERE broadcast_send_id IS NOT NULL;
    ELSE
      RAISE NOTICE 'email_send_log has ~% rows; build by hand: CREATE INDEX CONCURRENTLY idx_esl_broadcast_send_lower_recipient ON public.email_send_log (broadcast_send_id, lower(recipient_email)) WHERE broadcast_send_id IS NOT NULL', v_rows;
    END IF;
  END IF;

  IF to_regclass('public.idx_esl_newsletter_send_lower_recipient') IS NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_send_log' AND column_name = 'newsletter_send_id') THEN
    IF v_small THEN
      CREATE INDEX idx_esl_newsletter_send_lower_recipient
        ON public.email_send_log (newsletter_send_id, lower(recipient_email))
        WHERE newsletter_send_id IS NOT NULL;
    ELSE
      RAISE NOTICE 'email_send_log has ~% rows; build by hand: CREATE INDEX CONCURRENTLY idx_esl_newsletter_send_lower_recipient ON public.email_send_log (newsletter_send_id, lower(recipient_email)) WHERE newsletter_send_id IS NOT NULL', v_rows;
    END IF;
  END IF;
END $$;
