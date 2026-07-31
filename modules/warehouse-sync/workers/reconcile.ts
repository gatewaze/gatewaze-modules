// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * warehouse-sync:reconcile — daily source-side row-count baseline (§12.3).
 *
 * Runs once a day off-peak (cron 03:17 UTC). For each in-scope table it calls
 * warehouse_sync_table_counts (live rows, deleted rows, max updated_at) and
 * writes a snapshot to warehouse_sync_reconcile. The warehouse daily test
 * diffs STAGING counts against the latest snapshot:
 *   • reference/dimension tables — exact match
 *   • large facts — within 0.1% or 1,000 rows, whichever is larger
 * (see snowflake/operations/tests_daily.sql).
 *
 * This side only produces the source truth; the comparison happens in Snowflake
 * where both counts are visible.
 */

import { createClient } from '@supabase/supabase-js';
import { RECONCILE_TARGETS } from '../lib/reconcile-targets.js';

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

export default async function handler(job, ctx) {
  const logger = ctx?.logger ?? console;
  const supabase =
    ctx?.supabase ??
    createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
      auth: { autoRefreshToken: false, persistSession: false },
    });

  const capturedAt = new Date().toISOString();
  const results = [];
  for (const t of RECONCILE_TARGETS) {
    const { data, error } = await supabase.rpc('warehouse_sync_table_counts', {
      p_schema: t.schema,
      p_table: t.table,
      p_deleted_col: t.deletedCol,
      p_updated_col: t.updatedCol,
    });
    if (error) {
      logger.warn?.(`[warehouse-sync:reconcile] ${t.schema}.${t.table} count failed: ${error.message}`);
      continue;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) continue;

    const insert = {
      captured_at: capturedAt,
      table_name: `${t.schema}.${t.table}`,
      live_rows: Number(row.live_rows ?? 0),
      deleted_rows: Number(row.deleted_rows ?? 0),
      max_updated_at: row.max_updated_at ?? null,
    };
    const { error: insErr } = await supabase.from('warehouse_sync_reconcile').insert(insert);
    if (insErr) {
      logger.warn?.(`[warehouse-sync:reconcile] insert failed for ${insert.table_name}: ${insErr.message}`);
      continue;
    }
    results.push(insert);
  }

  logger.info?.(`[warehouse-sync:reconcile] captured ${results.length}/${RECONCILE_TARGETS.length} table snapshots`);
  return { captured: results.length, tables: results.map((r) => r.table_name) };
}
