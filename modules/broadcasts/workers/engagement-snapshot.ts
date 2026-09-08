import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface SnapshotJobData { kind: string }

/**
 * Background snapshotter for broadcast engagement — mirror of the newsletters
 * edition-snapshot worker.
 *
 * broadcast_engagement is served from broadcast_engagement_snapshots, keyed by a
 * data-version that is stable once the send completes. Opens/clicks keep
 * arriving for days after a send, so a snapshot taken right after completion
 * would freeze the numbers. Each tick:
 *   1. broadcast_find_sends_needing_snapshot — completed broadcasts whose
 *      snapshot is missing, young (<30d) and >2h stale, or >7d stale (weekly
 *      catch-all for the occasional late open/click on a mature broadcast).
 *   2. broadcast_refresh_engagement_snapshot(id) on each — recompute via the
 *      _live query and upsert.
 *
 * Registered every 5 min (broadcasts/index.ts crons, `broadcast-engagement-
 * snapshot`). Idempotent; a single refresh failure is logged and skipped.
 */
export default async function handleBroadcastEngagementSnapshot(_job: Job<SnapshotJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const batch = Number(process.env.BROADCASTS_SNAPSHOT_BATCH ?? 50);
  const youngDays = Number(process.env.BROADCASTS_SNAPSHOT_YOUNG_DAYS ?? 30);

  const { data: due, error: findErr } = await supabase.rpc(
    'broadcast_find_sends_needing_snapshot',
    { p_limit: batch, p_young_days: youngDays },
  );
  if (findErr) {
    throw new Error(`[broadcasts:engagement-snapshot] find failed: ${findErr.message}`);
  }
  const rows = (due ?? []) as Array<{ broadcast_id: string; data_version_ts: string }>;
  if (rows.length === 0) {
    return { refreshed: 0, errors: 0, message: 'no broadcasts due' };
  }

  let refreshed = 0;
  let errors = 0;
  for (const row of rows) {
    const { error: refErr } = await supabase.rpc(
      'broadcast_refresh_engagement_snapshot',
      { p_broadcast_id: row.broadcast_id },
    );
    if (refErr) {
      errors++;
      console.error(
        `[broadcasts:engagement-snapshot] refresh failed for ${row.broadcast_id}:`,
        refErr.message,
      );
      continue;
    }
    refreshed++;
  }

  console.log(
    `[broadcasts:engagement-snapshot] batch=${batch} due=${rows.length} `
    + `refreshed=${refreshed} errors=${errors}`,
  );
  return { refreshed, errors, due: rows.length };
}
