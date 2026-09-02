// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * warehouse-sync apiRoutes. Thin admin endpoints under
 * /api/modules/warehouse-sync/*. The Airbyte credentials + token live only
 * here (server-side); the admin app never receives them (§13 security). "Sync
 * now" enqueues the airbyte-status worker, which owns the Airbyte client.
 */

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class FakeWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
}

import { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireJwt } from '../lib/require-jwt.js';
import { AirbyteClient } from '../lib/airbyte-client.js';
import { planTiers } from '../lib/sync-planner.js';

const CRON = {
  realtime: '0 */5 * * * ?', // every 5 min — near-real-time
  hourly: '0 0 * * * ?',     // top of every hour
  daily: '0 0 3 * * ?',      // 03:00 UTC
};

/** Build the Airbyte client from the persisted module config + find the single source/destination. */
async function airbyteContext(supabase) {
  const { data: row } = await supabase
    .from('installed_modules').select('config').eq('id', 'warehouse-sync').maybeSingle();
  const cfg = (row?.config ?? {}) as Record<string, unknown>;
  if (!cfg.airbyteApiUrl || !cfg.airbyteWorkspaceId) return { client: null, cfg };
  const client = new AirbyteClient({
    baseUrl: cfg.airbyteApiUrl as string,
    workspaceId: cfg.airbyteWorkspaceId as string,
    token: (cfg.airbyteApiToken as string) || undefined,
  });
  const [sources, dests] = await Promise.all([client.listSources(), client.listDestinations()]);
  const sourceId = (cfg.airbyteSourceId as string) || (sources.length === 1 ? sources[0].sourceId : null);
  const destinationId = (cfg.airbyteDestinationId as string) || (dests.length === 1 ? dests[0].destinationId : null);
  return { client, cfg, sourceId, destinationId };
}

function logger() {
  return {
    info: (m, x) => console.log(`[warehouse-sync] ${m}`, x ?? ''),
    warn: (m, x) => console.warn(`[warehouse-sync] ${m}`, x ?? ''),
  };
}

interface RegisterCtx {
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

export async function registerRoutes(app: Express, ctx?: RegisterCtx): Promise<void> {
  const log = logger();
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const r = Router();

  // AUTH GATE — the platform does NOT gate dynamic module routes, so these
  // endpoints (enumerate Airbyte connections, trigger syncs) are otherwise
  // unauthenticated. Require a verified session (requireJwt) AND an active
  // admin/editor role, mirroring vehicle-video. The service-role `supabase`
  // client below bypasses RLS, so without this any caller reaching the network
  // prefix could enumerate connections and drive sync spend.
  r.use(requireJwt());
  const requireAdmin = async (req, res, next): Promise<void> => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'No session' } });
      return;
    }
    const { data } = await supabase
      .from('admin_profiles')
      .select('role, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    const ok = !!data && data.is_active && ['super_admin', 'admin', 'editor'].includes(data.role);
    if (!ok) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Admin access required' } });
      return;
    }
    next();
  };
  r.use(requireAdmin);

  // Latest Airbyte sync state (from the local table the worker maintains).
  r.get('/airbyte/connections', async (_req, res) => {
    const { data, error } = await supabase
      .from('warehouse_sync_airbyte_connections')
      .select('*')
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ connections: data ?? [] });
  });

  // Trigger a manual sync — enqueue the worker (which holds the Airbyte client).
  r.post('/airbyte/connections/:id/sync', async (req, res) => {
    const connectionId = req.params.id;
    if (!ctx?.enqueueJob) {
      return res.status(503).json({ error: 'enqueue not available on this host' });
    }
    const { id } = await ctx.enqueueJob('jobs', 'warehouse-sync:airbyte-status', {
      kind: 'warehouse-sync:airbyte-status',
      triggerSyncConnectionId: connectionId,
    });
    log.info(`enqueued Airbyte sync for ${connectionId} → job ${id}`);
    return res.json({ enqueued: true, jobId: id, connectionId });
  });

  // ── Tables tab: list source tables merged with their saved sync config ─────
  r.get('/tables', async (_req, res) => {
    try {
      const { client, sourceId, destinationId } = await airbyteContext(supabase);
      let discovered: string[] = [];
      let discoverError: string | null = null;
      if (client && sourceId && destinationId) {
        try { discovered = await client.discoverStreams(sourceId, destinationId); }
        catch (e) { discoverError = e?.message ?? String(e); }
      } else {
        discoverError = 'Airbyte not configured (airbyteApiUrl/airbyteWorkspaceId) or source/destination ambiguous';
      }
      const { data: cfgs } = await supabase.from('warehouse_sync_table_config').select('*');
      const cfgByName = new Map((cfgs ?? []).map((c) => [c.table_name, c]));
      // Union of discovered tables + already-configured ones.
      const names = new Set<string>([...discovered, ...(cfgs ?? []).map((c) => c.table_name)]);
      const tables = [...names].sort().map((name) => {
        const c = cfgByName.get(name);
        return {
          table_name: name,
          enabled: c?.enabled ?? false,
          sync_mode: c?.sync_mode ?? 'incremental',
          frequency: c?.frequency ?? 'realtime',
          cursor_field: c?.cursor_field ?? 'updated_at',
          primary_key: c?.primary_key ?? 'id',
          use_cdc: c?.use_cdc ?? false,
          include_pii: c?.include_pii ?? true,
        };
      });
      return res.json({ tables, discoverError, configured: !!(client && sourceId && destinationId) });
    } catch (e) {
      return res.status(500).json({ error: e?.message ?? 'failed to load tables' });
    }
  });

  // Save per-table config + reconcile into Airbyte connections (one per tier).
  r.put('/tables', async (req, res) => {
    const rows = Array.isArray(req.body?.tables) ? req.body.tables : null;
    if (!rows) return res.status(400).json({ error: 'body.tables[] required' });
    const actor = (req as { userId?: string }).userId ?? null;
    // 1. persist desired config (allowlist fields; never raw body).
    const upserts = rows.map((t) => ({
      table_name: String(t.table_name),
      namespace: 'public',
      enabled: !!t.enabled,
      sync_mode: t.sync_mode === 'full_refresh' ? 'full_refresh' : 'incremental',
      frequency: ['realtime', 'hourly', 'daily'].includes(t.frequency) ? t.frequency : 'realtime',
      cursor_field: t.cursor_field ? String(t.cursor_field) : null,
      primary_key: t.primary_key ? String(t.primary_key) : null,
      use_cdc: !!t.use_cdc,
      include_pii: t.include_pii !== false, // default true (full row); false = redact PII
      updated_at: new Date().toISOString(),
      updated_by: actor,
    }));
    const { error: upErr } = await supabase.from('warehouse_sync_table_config').upsert(upserts, { onConflict: 'table_name' });
    if (upErr) return res.status(500).json({ error: `save failed: ${upErr.message}` });

    // 2. reconcile into Airbyte.
    try {
      const { client, sourceId, destinationId } = await airbyteContext(supabase);
      if (!client || !sourceId || !destinationId) {
        return res.json({ saved: true, reconciled: false, reason: 'Airbyte not configured / source-destination ambiguous' });
      }
      const { data: cfgs } = await supabase.from('warehouse_sync_table_config').select('*');

      // Discover the source catalog so streams are validated/repaired against
      // real cursor/PK/fields (and so PII redaction knows the column list).
      const catalogByName = new Map();
      try {
        const catalog = await client.discoverCatalog(sourceId);
        for (const s of catalog) catalogByName.set(s.name, s);
      } catch (e) {
        log.warn('catalog discovery failed; reconcile will skip validation', e?.message ?? e);
      }

      const { tiers: plans, skipped } = planTiers(cfgs ?? [], catalogByName);
      const summary = [];
      for (const plan of plans) {
        const { data: tier } = await supabase
          .from('warehouse_sync_tiers').select('*').eq('frequency', plan.frequency).maybeSingle();
        const schedule = { scheduleType: 'cron', cronExpression: CRON[plan.frequency], cronTimeZone: 'UTC' };
        try {
          if (plan.streams.length === 0) {
            if (tier?.connection_id) await client.updateConnection(tier.connection_id, { status: 'inactive' });
            summary.push({ frequency: plan.frequency, streams: 0, action: 'paused' });
          } else if (tier?.connection_id) {
            await client.updateConnection(tier.connection_id, {
              configurations: { streams: plan.streams }, schedule, status: 'active',
            });
            summary.push({ frequency: plan.frequency, streams: plan.streams.length, action: 'updated' });
          } else {
            const conn = await client.createConnection({
              name: `wh-sync-${plan.frequency}`, sourceId, destinationId,
              namespaceDefinition: 'destination',
              configurations: { streams: plan.streams }, schedule, status: 'active',
            });
            await supabase.from('warehouse_sync_tiers')
              .upsert({ frequency: plan.frequency, connection_id: conn.connectionId, schedule_json: schedule, last_reconciled_at: new Date().toISOString(), reconcile_error: null }, { onConflict: 'frequency' });
            summary.push({ frequency: plan.frequency, streams: plan.streams.length, action: 'created', connectionId: conn.connectionId });
          }
          await supabase.from('warehouse_sync_tiers').update({ last_reconciled_at: new Date().toISOString(), reconcile_error: null }).eq('frequency', plan.frequency);
        } catch (e) {
          await supabase.from('warehouse_sync_tiers').update({ reconcile_error: e?.message ?? String(e) }).eq('frequency', plan.frequency);
          summary.push({ frequency: plan.frequency, streams: plan.streams.length, action: 'error', error: e?.message ?? String(e) });
        }
      }
      return res.json({ saved: true, reconciled: true, tiers: summary, skipped });
    } catch (e) {
      return res.status(500).json({ error: `reconcile failed: ${e?.message ?? e}` });
    }
  });

  app.use('/api/modules/warehouse-sync', r);
  log.info('routes registered');
}
