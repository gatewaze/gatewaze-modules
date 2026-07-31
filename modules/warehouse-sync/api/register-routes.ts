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

  app.use('/api/modules/warehouse-sync', r);
  log.info('routes registered');
}
