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
import { loadModuleConfig } from '../lib/module-config.js';
import { deliverAlert } from '../lib/alert-sink.js';

/**
 * Raise an alert AND actually send it.
 *
 * This worker used to insert `notified: false` and stop there, with no call to
 * deliverAlert anywhere in the file — only slot-monitor delivered. So every
 * failed-sync alert it ever raised went into a table nobody reads. On 6 Nov
 * 2026 there was an open airbyte_sync_failed row for this connection that had
 * been sitting unsent for seven days while the warehouse went stale.
 *
 * It also re-attempts delivery for an alert that is open but still unnotified.
 * The old "skip if one is already open" check meant a single failed POST turned
 * into permanent silence, because nothing ever retried it.
 */
async function raise(supabase, cfg, logger, key, code, severity, value, message) {
  const { data: open } = await supabase
    .from('warehouse_sync_alerts')
    .select('id, notified')
    .eq('code', code)
    .eq('slot_name', key)
    .is('resolved_at', null)
    .limit(1);

  const existing = open?.[0];
  if (existing && existing.notified) return; // already paged, don't flap

  const alert = { slot_name: key, code, severity, message };
  const notified = await deliverAlert(alert, cfg, supabase, logger);
  if (!notified) {
    logger.warn?.(
      `[warehouse-sync:airbyte-status] ${code} for ${key} could NOT be delivered — ` +
        'no alertWebhookUrl or alertSlackChannel is configured (set WAREHOUSE_SYNC_ALERT_WEBHOOK_URL)',
    );
  }

  if (existing) {
    await supabase.from('warehouse_sync_alerts').update({ notified }).eq('id', existing.id);
  } else {
    await supabase
      .from('warehouse_sync_alerts')
      .insert({ slot_name: key, code, severity, value, message, notified });
  }
}

/**
 * Validate an operator-supplied outbound URL before this worker fetches it.
 *
 * heartbeatUrl is not in the module's configSchema, and core's config PUT
 * merges req.body.config wholesale with no key allowlist, so anyone past
 * requireLeadership can set it. This worker runs inside the cluster holding
 * SUPABASE_SERVICE_ROLE_KEY, so an unvalidated fetch is an SSRF primitive
 * against cluster-internal services and the 169.254.0.0/16 metadata range.
 *
 * Returns the parsed URL, or null when it must not be fetched.
 */
export function safeOutboundUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null; // includes the scheme-less typo case
  }
  if (u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return null;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return null;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 169 && b === 254) return null; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return null; // CGNAT
  }
  return u;
}

async function resolve(supabase, key, code) {
  await supabase
    .from('warehouse_sync_alerts')
    .update({ resolved_at: new Date().toISOString() })
    .eq('code', code)
    .eq('slot_name', key)
    .is('resolved_at', null);
}

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

  // The worker host does not populate ctx.moduleConfig, so read the persisted
  // row. Without this this worker skipped on every tick, reporting Airbyte as
  // unconfigured while airbyteApiUrl/airbyteWorkspaceId were in fact set.
  const cfg = await loadModuleConfig(supabase, ctx);

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

    // A connection Airbyte has disabled itself is its own failure mode, and the
    // one that turned the 30 Oct outage into a week of silence: after enough
    // consecutive failures Airbyte set this connection inactive, so the cron
    // stopped firing entirely and "latest job failed" stopped being true. The
    // last job just sat there, succeeded or failed, going stale. Alert on it.
    if (String(c.status ?? '').toLowerCase() !== 'active') {
      failures += 1;
      await raise(
        supabase,
        cfg,
        logger,
        c.connectionId,
        'airbyte_connection_disabled',
        'critical',
        null,
        `Airbyte connection '${c.name}' is ${c.status} — no syncs will run until it is re-enabled`,
      );
    } else {
      await resolve(supabase, c.connectionId, 'airbyte_connection_disabled');
    }

    if (latest?.status === 'failed') {
      failures += 1;
      await raise(
        supabase,
        cfg,
        logger,
        c.connectionId,
        'airbyte_sync_failed',
        'critical',
        latest.jobId ?? null,
        `Airbyte connection '${c.name}' latest sync failed (job ${latest.jobId})`,
      );
    } else {
      await resolve(supabase, c.connectionId, 'airbyte_sync_failed');
    }

    // Dead-man's switch on the data itself. Every check above asks "did the last
    // job fail", which is silent when no job runs at all — a disabled
    // connection, a stopped scheduler, a worker that never fired. This asks the
    // only question that catches all of those: when did a sync last SUCCEED?
    const silenceHours = Number(cfg.syncSilenceAlertHours ?? 6);
    const lastAt = row.last_job_at ? Date.parse(row.last_job_at) : NaN;
    const staleFor = Number.isFinite(lastAt) ? (Date.now() - lastAt) / 3600000 : Infinity;
    const succeeded = String(latest?.status ?? '').toLowerCase() === 'succeeded';
    if (!succeeded || staleFor > silenceHours) {
      if (staleFor > silenceHours) {
        failures += 1;
        await raise(
          supabase,
          cfg,
          logger,
          c.connectionId,
          'sync_silent',
          'critical',
          Math.round(staleFor),
          `Airbyte connection '${c.name}' has not completed a successful sync for ${
            Number.isFinite(staleFor) ? `${staleFor.toFixed(1)}h` : 'an unknown period'
          } (threshold ${silenceHours}h) — the replication slot burns down in roughly 5 to 8h from a stalled sync`,
        );
      }
    } else {
      await resolve(supabase, c.connectionId, 'sync_silent');
    }
  }

  // External dead-man's switch. Everything above runs inside the system it is
  // watching, so it cannot report that it is itself down — and across four slot
  // losses the failure was never detection, it was that the signal reached
  // nobody. Pinging an outside check (healthchecks.io, Cronitor, Better Stack)
  // only while healthy inverts the dependency: if this worker, the scheduler,
  // the cluster or the database stops, the ping stops, and the OUTSIDE service
  // raises the alarm. That alerts on silence, which is the shape every one of
  // these incidents actually had.
  const heartbeatUrl = String(cfg.heartbeatUrl ?? '');
  if (heartbeatUrl && failures === 0) {
    const target = safeOutboundUrl(heartbeatUrl);
    if (!target) {
      // Deliberately does not echo the value. A ping URL is bearer-equivalent:
      // anyone who can read it can forge heartbeats and hold the external
      // dead-man's switch green while this worker is dead, which defeats the
      // only control here that does not depend on the cluster being alive.
      logger.warn?.(
        '[warehouse-sync:airbyte-status] heartbeatUrl is not a usable public https URL — ' +
          'heartbeat skipped (value not logged; it is a credential)',
      );
    } else {
      try {
        const res = await fetch(target.href, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          logger.warn?.(`[warehouse-sync:airbyte-status] heartbeat to ${target.host} returned ${res.status}`);
        }
      } catch (e) {
        // Host only. The thrown message can contain the full URL.
        logger.warn?.(`[warehouse-sync:airbyte-status] heartbeat to ${target.host} failed: ${e?.name ?? 'Error'}`);
      }
    }
  } else if (!heartbeatUrl) {
    logger.info?.(
      '[warehouse-sync:airbyte-status] no heartbeatUrl configured — nothing outside this cluster ' +
        'would notice if this worker stopped (set WAREHOUSE_SYNC_HEARTBEAT_URL)',
    );
  }

  logger.info?.(`[warehouse-sync:airbyte-status] polled ${connections.length} connection(s), ${failures} failing`);
  return { configured: true, connections: connections.length, failures };
}
