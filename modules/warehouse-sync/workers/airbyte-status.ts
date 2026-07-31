// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * warehouse-sync:airbyte-status — poll the central Airbyte (Option B) for
 * this brand's workspace and upsert the latest sync state per connection into
 * warehouse_sync_airbyte_connections, so the dashboard reads a cheap local
 * table instead of hitting Airbyte on every render. Raises a
 * warehouse_sync_alerts row when a connection's latest sync failed.
 *
 * Runs every 5 min (cron). No-op (logs + returns) when Airbyte isn't configured.
 *
 * Job data (optional): { triggerSyncConnectionId } forces a manual sync of one
 * connection before polling (used by the dashboard "Sync now" button via an
 * enqueue).
 */

import { createClient } from '@supabase/supabase-js';
import { airbyteClientFromConfig } from '../lib/airbyte-client.js';

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

export default async function handler(job, ctx) {
  const logger = ctx?.logger ?? console;
  const cfg = (ctx?.moduleConfig ?? {}) as Record<string, unknown>;
  const supabase =
    ctx?.supabase ??
    createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
      auth: { autoRefreshToken: false, persistSession: false },
    });

  const airbyte = airbyteClientFromConfig(cfg);
  if (!airbyte) {
    logger.info?.('[warehouse-sync:airbyte-status] Airbyte not configured (airbyteApiUrl/airbyteWorkspaceId) — skipping.');
    return { configured: false };
  }

  // Optional forced sync (from the dashboard).
  const forceId = job?.data?.triggerSyncConnectionId as string | undefined;
  if (forceId) {
    try {
      const j = await airbyte.triggerSync(forceId);
      logger.info?.(`[warehouse-sync:airbyte-status] triggered sync job ${j.jobId} for ${forceId}`);
    } catch (e) {
      logger.warn?.(`[warehouse-sync:airbyte-status] triggerSync failed: ${e?.message ?? e}`);
    }
  }

  let connections;
  try {
    connections = await airbyte.listConnections();
  } catch (e) {
    logger.error?.(`[warehouse-sync:airbyte-status] listConnections failed: ${e?.message ?? e}`);
    throw e;
  }

  let failures = 0;
  for (const c of connections) {
    let latest = null;
    try {
      const jobs = await airbyte.listJobs(c.connectionId, 1);
      latest = jobs[0] ?? null;
    } catch (e) {
      logger.warn?.(`[warehouse-sync:airbyte-status] listJobs failed for ${c.connectionId}: ${e?.message ?? e}`);
    }

    const row = {
      connection_id: c.connectionId,
      name: c.name,
      status: c.status,
      last_job_id: latest?.jobId ?? null,
      last_job_status: latest?.status ?? null,
      last_job_at: latest?.lastUpdatedAt ?? latest?.startTime ?? null,
      rows_synced: latest?.rowsSynced ?? null,
      bytes_synced: latest?.bytesSynced ?? null,
      last_error: latest?.status === 'failed' ? 'latest sync failed — see Airbyte job logs' : null,
      observed_at: new Date().toISOString(),
    };
    await supabase.from('warehouse_sync_airbyte_connections').upsert(row, { onConflict: 'connection_id' });

    if (latest?.status === 'failed') {
      failures += 1;
      // Reuse the alert table so failed syncs page alongside slot alerts.
      const { data: open } = await supabase
        .from('warehouse_sync_alerts')
        .select('id')
        .eq('code', 'airbyte_sync_failed')
        .eq('slot_name', c.connectionId)
        .is('resolved_at', null)
        .limit(1);
      if (!open || open.length === 0) {
        await supabase.from('warehouse_sync_alerts').insert({
          slot_name: c.connectionId,
          code: 'airbyte_sync_failed',
          severity: 'critical',
          value: latest.jobId ?? null,
          message: `Airbyte connection '${c.name}' latest sync failed (job ${latest.jobId})`,
          notified: false,
        });
      }
    } else {
      // Resolve any open failure alert for this connection.
      await supabase
        .from('warehouse_sync_alerts')
        .update({ resolved_at: new Date().toISOString() })
        .eq('code', 'airbyte_sync_failed')
        .eq('slot_name', c.connectionId)
        .is('resolved_at', null);
    }
  }

  logger.info?.(`[warehouse-sync:airbyte-status] polled ${connections.length} connection(s), ${failures} failing`);
  return { configured: true, connections: connections.length, failures };
}
