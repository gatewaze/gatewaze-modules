// @ts-nocheck — depends on @supabase/supabase-js + express which require
// `pnpm install` at the modules workspace level. Excluded from the strict
// tsconfig until the workspace install is wired up. Runtime shape is
// correct; type errors here are bounded to import resolution.
/**
 * Webhooks module — apiRoutes hook entry point.
 *
 * Wires:
 *   1. The Webhook Hub (debounce + fan-out + Cloudflare purge)
 *   2. The LISTEN gatewaze.mutation worker
 *   3. Admin routes for managing webhook_subscriptions
 *
 * Mounted on /api/admin under the platform's labeledRouter('jwt'); the
 * admin auth is enforced upstream.
 */

import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { Client as PgClient } from 'pg';
import { createAdminRoutes, mountAdminRoutes } from './admin-routes.js';
import { WebhookHub, makeCloudflarePurger } from '../lib/webhook-hub.js';
import { ListenWorker } from '../lib/listen-worker.js';

export function registerRoutes(app: unknown): void {
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`[webhooks] ${msg}`, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[webhooks] ${msg}`, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(`[webhooks] ${msg}`, meta ?? ''),
  };

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    logger.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set; webhooks module disabled');
    return;
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ─── Webhook Hub ────────────────────────────────────────────────────
  const cloudflarePurger = makeCloudflarePurger({
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? null,
    zoneId: process.env.CLOUDFLARE_ZONE_ID ?? null,
    logger,
  });
  const hub = new WebhookHub({
    supabase,
    logger,
    cloudflarePurger,
  });

  // ─── LISTEN worker ──────────────────────────────────────────────────
  const connectionString =
    process.env.SUPABASE_DB_URL
    ?? process.env.DATABASE_URL
    ?? process.env.POSTGRES_URL
    ?? null;
  if (!connectionString) {
    logger.warn(
      'SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL not set — LISTEN worker disabled. Layer-2 fan-out will not fire on mutations.',
    );
  } else {
    const worker = new ListenWorker({
      connectionString,
      hub,
      logger,
      ClientImpl: PgClient,
    });
    void worker.start().catch((err: unknown) => {
      logger.error('webhooks.listen_worker_start_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    (globalThis as Record<string, unknown>).__gatewazeWebhooksWorker = worker;
    (globalThis as Record<string, unknown>).__gatewazeWebhooksHub = hub;
  }

  // ─── Admin routes ───────────────────────────────────────────────────
  const router = Router();
  const routes = createAdminRoutes({
    supabase,
    logger,
    getUserId: (req) => req.userId ?? null,
  });
  mountAdminRoutes(router, routes);
  app.use('/api/admin', router);

  logger.info('webhooks module routes registered');
}
