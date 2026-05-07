// @ts-nocheck — same justification as templates/api/register-routes.ts:
// this file lives in the modules workspace where cross-workspace
// `@gatewaze/shared` peer-deps don't resolve under `tsc --noEmit`. The
// runtime resolves them via the api server's loader.

/**
 * Register the analytics module's HTTP routes against the platform's
 * Express app.
 *
 * Two route trees:
 *   /api/analytics/*                  — JWT-protected (properties + dashboards)
 *   /a/*                              — public (ingest + pixel bundle)
 *
 * The ingest tree is mounted on the portal so it's same-origin with
 * sites and portal pages. The properties+dashboards tree is mounted on
 * the admin api server.
 */

import type { Express, Request } from 'express';
import { createPropertiesRoutes, mountPropertiesRoutes } from './properties.js';
import { createDashboardsRoutes, mountDashboardsRoutes } from './dashboards.js';
import { createSitesConvenienceRoutes, mountSitesConvenienceRoutes } from './sites-convenience.js';
import { createIngestRoutes, mountIngestRoutes } from './ingest.js';
import { createUmamiClient } from '../service/umami-client.js';
import { createUmamiAnalyticsService } from '../service/umami.js';

interface ModuleContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceRoleSupabase?: any;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labeledRouter?: (label: 'jwt' | 'public' | 'service') => any;
  /** Encrypts a plaintext secret for storage. */
  encryptSecret?: (plaintext: string) => Buffer;
  /** Decrypts a stored secret blob. */
  decryptSecret?: (encrypted: Buffer | string) => string;
  rateLimit?: (key: string, max: number, windowMs: number) => Promise<{ allowed: boolean; resetAt: number }>;
}

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function registerRoutes(app: Express, context?: ModuleContext): void {
  if (!context?.supabase) {
    // eslint-disable-next-line no-console
    console.warn('[analytics] registerRoutes: no supabase in context; skipping route mount');
    return;
  }
  const logger = context.logger ?? noopLogger;
  const serviceRoleClient = context.serviceRoleSupabase ?? context.supabase;

  // -------- properties + dashboards (JWT-protected admin routes) --------
  const jwtRouter = context.labeledRouter ? context.labeledRouter('jwt') : app;

  const propertiesRoutes = createPropertiesRoutes({
    supabase: context.supabase,
    encryptSecret: context.encryptSecret ?? ((s: string) => Buffer.from(s, 'utf-8')),
    logger,
    getUserId: (req: Request) => {
      const user = (req as Request & { user?: { id?: string } }).user;
      return user?.id ?? null;
    },
  });

  // Build the analyticsService for the dashboard routes. The Umami client
  // uses the operator-supplied admin credentials (UMAMI_USERNAME +
  // UMAMI_PASSWORD env). Default callerRole is 'authenticated'; the
  // cache scope keeps cross-user reads isolated even when admin tier
  // is the same.
  const umamiClient = createUmamiClient({
    baseUrl: process.env['UMAMI_BASE_URL'] ?? 'http://umami:3000',
    username: process.env['UMAMI_USERNAME'] ?? 'admin',
    password: process.env['UMAMI_PASSWORD'] ?? '',
  });
  const analyticsService = createUmamiAnalyticsService({
    supabase: serviceRoleClient,
    umami: umamiClient,
    callerRole: 'authenticated',
    // Browser-reachable Umami URL — drives the v3 session-replay deep
    // link. UMAMI_BASE_URL is the in-cluster service name and isn't
    // useful to the dashboard iframe.
    publicBaseUrl: process.env['UMAMI_PUBLIC_BASE_URL'] ?? process.env['UMAMI_BASE_URL'] ?? '',
  });
  const dashboardsRoutes = createDashboardsRoutes({
    service: analyticsService,
    logger,
    getUserId: (req: Request) => {
      const user = (req as Request & { user?: { id?: string } }).user;
      return user?.id ?? null;
    },
  });

  // Site-scoped convenience routes — same dashboard surface, addressed
  // by site_id rather than property_id. Drives the per-page analytics
  // tab in the sites editor where the caller knows the site but not
  // its property uuid.
  const sitesConvenienceRoutes = createSitesConvenienceRoutes({
    service: analyticsService,
    supabase: serviceRoleClient,
    logger,
    getUserId: (req: Request) => {
      const user = (req as Request & { user?: { id?: string } }).user;
      return user?.id ?? null;
    },
  });

  if (context.labeledRouter) {
    mountPropertiesRoutes(jwtRouter, propertiesRoutes);
    mountDashboardsRoutes(jwtRouter, dashboardsRoutes);
    mountSitesConvenienceRoutes(jwtRouter, sitesConvenienceRoutes);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express.Router() return shape isn't load-bearing; the typed routes mount via mountSourcesRoutes
    const express = require('express') as { Router(): any };
    const sub = express.Router();
    mountPropertiesRoutes(sub, propertiesRoutes);
    mountDashboardsRoutes(sub, dashboardsRoutes);
    mountSitesConvenienceRoutes(sub, sitesConvenienceRoutes);
    app.use('/api/analytics', sub);
  }

  // -------- public ingest routes ('/a/*') --------
  const publicRouter = context.labeledRouter ? context.labeledRouter('public') : app;

  const ingestRoutes = createIngestRoutes({
    supabase: serviceRoleClient,
    umamiCollect: async (payload, headers) => {
      const baseUrl = (process.env['UMAMI_BASE_URL'] ?? 'http://umami:3000').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
      });
      return { ok: res.ok, status: res.status };
    },
    decryptSecret: context.decryptSecret ?? ((b: Buffer | string) => Buffer.isBuffer(b) ? b.toString('utf-8') : (b as string)),
    rateLimit: context.rateLimit ?? (async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
    logger,
    perIpRpm: getEnvNumber('ANALYTICS_INGEST_PER_IP_RPM', 200),
    perPropertyRpm: getEnvNumber('ANALYTICS_INGEST_PER_PROPERTY_RPM', 5000),
    embedCacheMaxAgeSeconds: getEnvNumber('ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS', 300),
  });

  if (context.labeledRouter) {
    mountIngestRoutes(publicRouter, ingestRoutes);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express.Router() return shape isn't load-bearing; the typed routes mount via mountSourcesRoutes
    const express = require('express') as { Router(): any };
    const sub = express.Router();
    mountIngestRoutes(sub, ingestRoutes);
    app.use('/', sub);
  }
}
