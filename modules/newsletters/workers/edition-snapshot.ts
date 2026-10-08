import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface SnapshotJobData {
  kind: string;
}

/**
 * Background snapshotter for the expensive per-edition stats RPCs.
 *
 * For each tick:
 *   1. Ask the DB for up to NEWSLETTERS_SNAPSHOT_BATCH editions whose latest
 *      send is at least NEWSLETTERS_SNAPSHOT_MIN_AGE_DAYS old AND whose
 *      engagement snapshot is missing or stale (per migration 061's
 *      `newsletter_find_editions_needing_snapshot` helper).
 *   2. Call `newsletter_refresh_edition_snapshots(edition_id)` on each one.
 *      The fn computes engagement + block_effectiveness via the *_live RPCs
 *      and upserts the snapshot rows.
 *
 * The cron is registered to fire every 5 min (modules/newsletters/index.ts
 * crons array, `newsletter-edition-snapshot`). Each run is bounded by a TIME
 * budget (NEWSLETTERS_SNAPSHOT_BUDGET_MS, default 60s) as well as the batch
 * size: the live engagement RPC costs 1-30s per edition, so an unbounded
 * 50-edition run after an outage held a worker slot for 25 minutes, two
 * overlapping runs held both slots, and 600+ jobs (the send drip included)
 * queued behind them (2026-10-08). The finder returns newest editions first,
 * so a budgeted run always refreshes the most-viewed ones; the remainder
 * waits for the next tick.
 *
 * Failure of a single refresh is logged + counted; the loop continues. The
 * job throws only if the bootstrap (RPC list-fetch) fails — that surfaces a
 * structural problem (DB unreachable, perms revoked) to BullMQ for retry.
 */
export default async function handleEditionSnapshot(_job: Job<SnapshotJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const batch = Number(process.env.NEWSLETTERS_SNAPSHOT_BATCH ?? 50);
  const minAgeDays = Number(process.env.NEWSLETTERS_SNAPSHOT_MIN_AGE_DAYS ?? 30);

  const { data: due, error: findErr } = await supabase.rpc(
    'newsletter_find_editions_needing_snapshot',
    { p_limit: batch, p_min_age_days: minAgeDays },
  );
  if (findErr) {
    throw new Error(`[newsletters:edition-snapshot] find failed: ${findErr.message}`);
  }
  const rows = (due ?? []) as Array<{ edition_id: string; data_version_ts: string }>;
  if (rows.length === 0) {
    return { refreshed: 0, errors: 0, message: 'no editions due' };
  }

  const budgetMs = Number(process.env.NEWSLETTERS_SNAPSHOT_BUDGET_MS ?? 60_000);
  const started = Date.now();
  let refreshed = 0;
  let errors = 0;
  let deferred = 0;
  for (const row of rows) {
    if (Date.now() - started > budgetMs) { deferred = rows.length - refreshed - errors; break; }
    const { error: refErr } = await supabase.rpc(
      'newsletter_refresh_edition_snapshots',
      { p_edition_id: row.edition_id },
    );
    if (refErr) {
      errors++;
      console.error(
        `[newsletters:edition-snapshot] refresh failed for ${row.edition_id}:`,
        refErr.message,
      );
      continue;
    }
    refreshed++;
  }

  console.log(
    `[newsletters:edition-snapshot] batch=${batch} due=${rows.length} `
    + `refreshed=${refreshed} errors=${errors} deferred=${deferred} ms=${Date.now() - started}`,
  );
  return { refreshed, errors, deferred, due: rows.length };
}
