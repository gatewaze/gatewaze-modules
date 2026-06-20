-- ============================================================================
-- Module: bulk-emailing
-- Migration: 010_send_engine_quota
-- Description: Central Sending Service foundation (spec-central-sending-service.md,
-- generalising spec-newsletter-tier2-throughput.md migration 049). The
-- account/brand/channel-wide SendGrid daily quota claimed atomically by the
-- shared worker drip, plus a generic stuck-row sweeper used across all domains
-- (newsletter / broadcast / bulk).
--
-- ADDITIVE + inert until the worker engine is wired and SEND_ENGINE_USE_WORKER
-- is flipped — nothing here changes current sending behaviour.
-- ============================================================================

-- Per-day quota, keyed (date, brand, channel). Channel lets SMS/WhatsApp get
-- their own caps later; email is the only channel for now.
CREATE TABLE IF NOT EXISTS public.sender_daily_quota (
  quota_date date NOT NULL,
  brand      text NOT NULL,
  channel    text NOT NULL DEFAULT 'email',
  reserved   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (quota_date, brand, channel)
);

-- Safety margin held back from the daily cap (0.9 = use 90%, reserve 10% for
-- transactional / unplanned). Single edit point for system-wide tuning.
CREATE OR REPLACE FUNCTION public.DRIP_QUOTA_SAFETY_MARGIN() RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT 0.9::numeric $$;

-- Atomic per-(brand,channel) quota claim. Row-locks the quota row so concurrent
-- worker replicas can't both approve the same headroom and breach the cap.
-- Returns the granted count (the claim p_limit for this tick; 0 = exit).
CREATE OR REPLACE FUNCTION public.claim_drip_quota(
  p_brand text, p_channel text, p_request integer, p_daily_cap integer
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_today    date := current_date;
  v_reserved integer;
  v_grant    integer;
BEGIN
  INSERT INTO public.sender_daily_quota (quota_date, brand, channel, reserved)
  VALUES (v_today, p_brand, COALESCE(p_channel, 'email'), 0)
  ON CONFLICT (quota_date, brand, channel) DO NOTHING;

  SELECT reserved INTO v_reserved
  FROM public.sender_daily_quota
  WHERE quota_date = v_today AND brand = p_brand AND channel = COALESCE(p_channel, 'email')
  FOR UPDATE;

  v_grant := least(p_request, greatest(0, (p_daily_cap * public.DRIP_QUOTA_SAFETY_MARGIN())::integer - v_reserved));
  IF v_grant > 0 THEN
    UPDATE public.sender_daily_quota
    SET reserved = reserved + v_grant
    WHERE quota_date = v_today AND brand = p_brand AND channel = COALESCE(p_channel, 'email');
  END IF;
  RETURN v_grant;
END $$;

-- Release reservation when a send is paused mid-flight (reputation watchdog,
-- operator stop). Idempotent.
CREATE OR REPLACE FUNCTION public.release_drip_quota(
  p_brand text, p_channel text, p_amount integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.sender_daily_quota
  SET reserved = greatest(0, reserved - p_amount)
  WHERE quota_date = current_date AND brand = p_brand AND channel = COALESCE(p_channel, 'email');
END $$;

-- Generic stuck-row sweeper (Tier 2 release_stuck_drip_rows, table-parametric so
-- newsletter/broadcast/bulk recipient queues all reuse it). Rows left in
-- 'sending' past p_stale_after (worker crashed between claim and batch-status
-- update) go back to 'pending' for re-claim. p_recipients_table is a trusted
-- value from the binding (identifier-quoted), never request input.
CREATE OR REPLACE FUNCTION public.release_stuck_send_rows(
  p_recipients_table text, p_stale_after interval DEFAULT '15 minutes'
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_released integer;
BEGIN
  EXECUTE format(
    'UPDATE public.%I SET status = ''pending'', last_error = ''released by stuck-row sweeper'', updated_at = now()
       WHERE status = ''sending'' AND updated_at < now() - $1',
    p_recipients_table
  ) USING p_stale_after;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END $$;

COMMENT ON FUNCTION public.claim_drip_quota(text, text, integer, integer) IS
  'Atomic per-(brand,channel) SendGrid daily-quota claim for the shared send-engine drip. Returns granted count.';
COMMENT ON FUNCTION public.release_stuck_send_rows(text, interval) IS
  'Table-parametric stuck-row sweeper: releases <table> rows stuck in sending past p_stale_after back to pending. Shared by all send domains.';
