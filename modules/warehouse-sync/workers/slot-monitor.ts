// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * warehouse-sync:slot-monitor — the §10.4 production safety net.
 *
 * Runs every 5 minutes (cron). Samples pg_replication_slots via the
 * warehouse_sync_slot_health RPC, records the sample to
 * warehouse_sync_slot_health, evaluates the §10.4 thresholds, and keeps an
 * open/resolved alert row per (slot, code) in warehouse_sync_alerts —
 * optionally POSTing breaches to a configured webhook. Also prunes operations
 * logs to retention (§13).
 *
 * A stalled or deleted-without-drop slot retains WAL and can fill the Supabase
 * disk (§10.4) — this monitor is what turns that silent failure into a page.
 *
 * Job data (optional): { slotName } overrides the configured slot for an ad-hoc run.
 */

import { createClient } from '@supabase/supabase-js';
import {
  evaluateSlot,
  isBusinessHoursUtc,
  thresholdsFromConfig,
} from '../lib/thresholds.js';

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

async function postWebhook(url, alert, logger) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `:rotating_light: [warehouse-sync] ${alert.severity.toUpperCase()} ${alert.slot_name}/${alert.code}: ${alert.message}`,
      }),
    });
    return res.ok;
  } catch (e) {
    logger.warn?.(`webhook post failed: ${e?.message ?? e}`);
    return false;
  }
}

export default async function handler(job, ctx) {
  const logger = ctx?.logger ?? console;
  const cfg = (ctx?.moduleConfig ?? {}) as Record<string, unknown>;
  const supabase =
    ctx?.supabase ??
    createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
      auth: { autoRefreshToken: false, persistSession: false },
    });

  const slotName = (job?.data?.slotName as string) ?? (cfg.replicationSlotName as string) ?? 'snowflake_cdc';
  const thresholds = thresholdsFromConfig(cfg);
  const webhookUrl = (cfg.alertWebhookUrl as string) ?? '';
  const businessHours = isBusinessHoursUtc(new Date().getUTCHours());

  const { data: rows, error } = await supabase.rpc('warehouse_sync_slot_health', {
    p_slot_name: slotName,
  });
  if (error) {
    logger.error?.(`[warehouse-sync:slot-monitor] slot_health RPC failed: ${error.message}`);
    throw new Error(`slot_health RPC failed: ${error.message}`);
  }

  const samples = Array.isArray(rows) ? rows : [];

  // Slot missing entirely — the connector never created it, or it was dropped
  // (either a not-yet-provisioned pipeline, or the §10.4 decommission hazard).
  if (samples.length === 0) {
    const missing = {
      slot_name: slotName,
      code: 'slot_missing',
      severity: businessHours ? 'critical' : 'warning',
      value: null,
      message: `replication slot '${slotName}' not present — connector not provisioned or slot dropped (§10.4)`,
    };
    await reconcileAlerts(supabase, slotName, [missing], webhookUrl, logger);
    await supabase.from('warehouse_sync_slot_health').insert({
      slot_name: slotName,
      active: false,
      retained_bytes: 0,
      flush_lag_bytes: 0,
      inactive_seconds: null,
      lag_seconds: null,
      alert_severity: missing.severity,
    });
    await prune(supabase, cfg, logger);
    logger.warn?.(`[warehouse-sync:slot-monitor] slot '${slotName}' missing`);
    return { slot: slotName, present: false, alerts: 1 };
  }

  let totalAlerts = 0;
  for (const s of samples) {
    const sample = {
      slot_name: s.slot_name,
      active: !!s.active,
      retained_bytes: Number(s.retained_bytes ?? 0),
      flush_lag_bytes: Number(s.flush_lag_bytes ?? 0),
      inactive_seconds: s.inactive_seconds == null ? null : Number(s.inactive_seconds),
      lag_seconds: s.lag_seconds == null ? null : Number(s.lag_seconds),
    };
    const alerts = evaluateSlot(sample, thresholds, businessHours);
    totalAlerts += alerts.length;
    const maxSeverity = alerts.some((a) => a.severity === 'critical')
      ? 'critical'
      : alerts.length
        ? 'warning'
        : null;

    await supabase.from('warehouse_sync_slot_health').insert({
      slot_name: sample.slot_name,
      active: sample.active,
      retained_bytes: sample.retained_bytes,
      flush_lag_bytes: sample.flush_lag_bytes,
      inactive_seconds: sample.inactive_seconds,
      lag_seconds: sample.lag_seconds,
      alert_severity: maxSeverity,
    });

    await reconcileAlerts(supabase, sample.slot_name, alerts, webhookUrl, logger);
  }

  await prune(supabase, cfg, logger);
  logger.info?.(`[warehouse-sync:slot-monitor] sampled ${samples.length} slot(s), ${totalAlerts} active alert(s)`);
  return { slot: slotName, present: true, samples: samples.length, alerts: totalAlerts };
}

/**
 * Open a row for each new alert code, clear (resolve) open rows whose condition
 * recovered this tick. Flap-free: an already-open alert is not re-notified.
 */
async function reconcileAlerts(supabase, slotName, alerts, webhookUrl, logger) {
  const { data: open } = await supabase
    .from('warehouse_sync_alerts')
    .select('id, code')
    .eq('slot_name', slotName)
    .is('resolved_at', null);
  const openByCode = new Map((open ?? []).map((r) => [r.code, r.id]));
  const currentCodes = new Set(alerts.map((a) => a.code));

  for (const a of alerts) {
    if (openByCode.has(a.code)) continue; // already open → don't re-page
    const notified = await postWebhook(webhookUrl, a, logger);
    await supabase.from('warehouse_sync_alerts').insert({
      slot_name: a.slot_name,
      code: a.code,
      severity: a.severity,
      value: a.value,
      message: a.message,
      notified,
    });
  }

  // Resolve recovered conditions.
  const toResolve = (open ?? []).filter((r) => !currentCodes.has(r.code)).map((r) => r.id);
  if (toResolve.length) {
    await supabase
      .from('warehouse_sync_alerts')
      .update({ resolved_at: new Date().toISOString() })
      .in('id', toResolve);
  }
}

async function prune(supabase, cfg, logger) {
  const days = Number(cfg.operationsLogDays ?? 30);
  const { error } = await supabase.rpc('warehouse_sync_prune_operations', { p_days: days });
  if (error) logger.warn?.(`[warehouse-sync:slot-monitor] prune failed: ${error.message}`);
}
