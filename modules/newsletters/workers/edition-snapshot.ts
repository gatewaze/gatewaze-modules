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
 * crons array, `newsletter-edition-snapshot`). At BATCH=50 and 5 min cadence
 * that's 600 editions/hour — well above any sane brand's edition cadence,
 * so the steady-state backlog stays empty and the system catches up quickly
 * after an outage.
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

  let refreshed = 0;
  let errors = 0;
  for (const row of rows) {
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
    + `refreshed=${refreshed} errors=${errors}`,
  );
  return { refreshed, errors, due: rows.length };
}
