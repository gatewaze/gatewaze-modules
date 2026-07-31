// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * software-engineer module — apiRoutes entry. Mounts:
 *   - PUBLIC webhook  → /api/modules/software-engineer/webhook   (HMAC-authed, no JWT)
 *   - Admin API       → /api/modules/software-engineer/admin/*   (platform JWT + is_admin)
 *
 * IMPORTANT (spec §6/§9): the webhook must NOT be JWT-gated — GitHub calls it unauthenticated.
 * The ai module mounts a public webhook under an otherwise-gated prefix; confirm the platform's
 * public-path handling for this exact route before go-live. The admin router is intentionally on
 * a distinct `/admin` sub-path so the platform's admin gate applies there and not to the webhook.
 */

// supabase-js >= 2.50 probes globalThis.WebSocket; shim it for Node (mirrors the ai module).
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class FakeWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
}

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { mountWebhookRoute } from './webhook-routes.js';
import { mountAdminRoutes } from './admin-routes.js';

export function registerRoutes(app, ctx) {
  const logger = ctx?.logger ?? console;
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const webhookSecret =
    ctx?.moduleConfig?.github_webhook_secret ?? process.env.SE_GITHUB_WEBHOOK_SECRET ?? '';
  const getRedis = ctx?.getRedisConnection ? () => ctx.getRedisConnection() : () => null;

  // Mounted under `/internal/` because the platform's core modulesRouter JWT-gates ALL of
  // /api/modules/* except paths containing `/internal/` (routes/modules.ts:72). GitHub can't
  // present a user JWT, so the webhook lives here and authenticates via HMAC instead. It does
  // NOT use the internal-key convention (that's for service-to-service); the `/internal/`
  // segment is purely to bypass the user-JWT gate. Endpoint: POST
  // /api/modules/software-engineer/internal/webhook.
  // TODO(platform): a first-class public-webhook exemption for modules would be cleaner (spec §6).
  const publicRouter = Router();
  mountWebhookRoute(publicRouter, { supabase, enqueueJob: ctx?.enqueueJob, webhookSecret, logger });
  app.use('/api/modules/software-engineer/internal', publicRouter);

  const adminRouter = Router();
  mountAdminRoutes(adminRouter, { supabase, getRedis, logger, enqueueJob: ctx?.enqueueJob });
  app.use('/api/modules/software-engineer/admin', adminRouter);
}
