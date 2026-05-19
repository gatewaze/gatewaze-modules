-- ============================================================================
-- One-off backfill: Anthropic web_search costs for May 2026 pre-fix days.
--
-- The runner now records `kind=tool, provider=anthropic, model=web_search`
-- rows alongside every LLM call (see lib/runner.ts after migration 010).
-- For days before the fix shipped, web_search billing exists on Anthropic's
-- dashboard but never landed in our ledger. This script writes one row per
-- pre-fix day so the ledger matches Anthropic.
--
-- Source: Anthropic admin workspace billing CSV (2026-05-12 → 2026-05-18).
-- Per-request cost = $10 / 1000 = $0.01 = 10_000 micro-USD.
-- Request count = USD / $0.01.
--
-- 2026-05-18 is INTENTIONALLY EXCLUDED — today's web_search calls land
-- organically through the new runner code after the API restart. Re-running
-- this script is safe: each row carries a unique request_id marker
-- ('backfill:anthropic-billing:YYYY-MM-DD') and a NOT EXISTS guard skips
-- days that have already been backfilled.
--
-- Run via:
--   docker exec -i example-supabase-db psql -U postgres -d postgres \
--     < gatewaze-modules/modules/ai/scripts/backfill-web-search-2026-05.sql
--
-- After running, verify with:
--   SELECT DATE(occurred_at), SUM(cost_micro_usd) / 1000000.0 AS usd
--   FROM ai_usage_events
--   WHERE provider = 'anthropic' AND model = 'web_search'
--   GROUP BY 1 ORDER BY 1;
-- ============================================================================

DO $$
DECLARE
  rec record;
  inserted_count int := 0;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      (DATE '2026-05-15', 23, 230000),  -- $0.23 CSV → 23 requests
      (DATE '2026-05-16',  6,  60000),  -- $0.06 →  6 requests
      (DATE '2026-05-17', 17, 170000)   -- $0.17 → 17 requests
    ) AS t(day, requests, cost_micro_usd)
  LOOP
    -- Idempotency: skip days that already have a backfill row.
    IF EXISTS (
      SELECT 1 FROM ai_usage_events
      WHERE request_id = 'backfill:anthropic-billing:' || to_char(rec.day, 'YYYY-MM-DD')
    ) THEN
      RAISE NOTICE 'skipping % — already backfilled', rec.day;
      CONTINUE;
    END IF;

    INSERT INTO ai_usage_events (
      occurred_at,
      user_id,
      use_case,
      thread_id,
      message_id,
      kind,
      provider,
      model,
      input_tokens,
      output_tokens,
      cached_tokens,
      cache_creation_tokens,
      image_outputs,
      bytes_in,
      bytes_out,
      browser_seconds,
      cost_micro_usd,
      latency_ms,
      status,
      error,
      request_id
    ) VALUES (
      -- Stamp at 23:59:00 UTC so the chart bucket lines up with the day
      -- and the row doesn't accidentally land in tomorrow's window.
      (rec.day::timestamp + INTERVAL '23 hours 59 minutes')::timestamptz,
      NULL,                                 -- system-attributed (no operator)
      'daily-briefing-research',            -- only use_case with web_search MTD
      NULL,
      NULL,
      'tool',
      'anthropic',
      'web_search',
      0,
      rec.requests,                          -- reuse output_tokens for request count (runner convention)
      0,
      0,
      0,
      0,
      0,
      0,
      rec.cost_micro_usd,
      0,
      'ok',
      NULL,
      'backfill:anthropic-billing:' || to_char(rec.day, 'YYYY-MM-DD')
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RAISE NOTICE 'backfill complete: % rows inserted', inserted_count;
END $$;
