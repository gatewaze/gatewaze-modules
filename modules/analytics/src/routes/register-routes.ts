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

import { Router, type Express, type Request } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createPropertiesRoutes, mountPropertiesRoutes } from './properties.js';
import { createDashboardsRoutes, mountDashboardsRoutes } from './dashboards.js';
import { createSitesConvenienceRoutes, mountSitesConvenienceRoutes } from './sites-convenience.js';
import { createIngestRoutes, mountIngestRoutes } from './ingest.js';
import { createSavedReportsRoutes, mountSavedReportsRoutes } from './saved-reports.js';
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
  const logger = context?.logger ?? noopLogger;

  // The platform's loader doesn't populate context.supabase for module
  // apiRoutes hooks (passes null), which used to make this fn early-return
  // and silently leave every /api/analytics/* + /api/modules/analytics/*
  // route unmounted. Build a service-role client locally as a fallback —
  // same pattern sites/host-media use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabaseClient: any = context?.supabase;
  if (!supabaseClient) {
    const supabaseUrl = process.env['SUPABASE_URL'] ?? '';
    const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    if (!supabaseUrl || !serviceRoleKey) {
      // eslint-disable-next-line no-console
      console.warn('[analytics] registerRoutes: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set; skipping route mount');
      return;
    }
    supabaseClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serviceRoleClient: any = (context as { serviceRoleSupabase?: unknown })?.serviceRoleSupabase ?? supabaseClient;
  // Shadow `context.supabase` references below by binding to local symbols.
  const ctx = { ...(context ?? {}), supabase: supabaseClient } as ModuleContext;
  void ctx;

  // -------- properties + dashboards (JWT-protected admin routes) --------
  const jwtRouter = context?.labeledRouter ? context.labeledRouter('jwt') : app;

  const propertiesRoutes = createPropertiesRoutes({
    supabase: supabaseClient,
    encryptSecret: context?.encryptSecret ?? ((s: string) => Buffer.from(s, 'utf-8')),
    logger,
    getUserId: (req: Request) => {
      // The platform's requireJwt() middleware sets `req.userId` (string).
      // Some older middleware paths set `req.user.id` (object) instead;
      // accept both so the module works with either auth wiring.
      const r = req as Request & { userId?: string; user?: { id?: string } };
      return r.userId ?? r.user?.id ?? null;
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
      // The platform's requireJwt() middleware sets `req.userId` (string).
      // Some older middleware paths set `req.user.id` (object) instead;
      // accept both so the module works with either auth wiring.
      const r = req as Request & { userId?: string; user?: { id?: string } };
      return r.userId ?? r.user?.id ?? null;
    },
  });

  const savedReportsRoutes = createSavedReportsRoutes({
    supabase: serviceRoleClient,
    logger,
    getUserId: (req: Request) => {
      const r = req as Request & { userId?: string; user?: { id?: string } };
      return r.userId ?? r.user?.id ?? null;
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
      // The platform's requireJwt() middleware sets `req.userId` (string).
      // Some older middleware paths set `req.user.id` (object) instead;
      // accept both so the module works with either auth wiring.
      const r = req as Request & { userId?: string; user?: { id?: string } };
      return r.userId ?? r.user?.id ?? null;
    },
  });

  if (context?.labeledRouter) {
    mountPropertiesRoutes(jwtRouter, propertiesRoutes);
    mountDashboardsRoutes(jwtRouter, dashboardsRoutes);
    mountSavedReportsRoutes(jwtRouter, savedReportsRoutes);
    mountSitesConvenienceRoutes(jwtRouter, sitesConvenienceRoutes);
  } else {
    const sub = Router();
    mountPropertiesRoutes(sub, propertiesRoutes);
    mountDashboardsRoutes(sub, dashboardsRoutes);
    mountSavedReportsRoutes(sub, savedReportsRoutes);
    mountSitesConvenienceRoutes(sub, sitesConvenienceRoutes);
    // Mount under /api/modules/analytics — the frontend (sites/admin/
    // pages/PageAnalytics.tsx) hits this prefix, and the platform's
    // /api/modules router already applies requireJwt() upstream.
    // /api/analytics/* is kept as a parallel mount for any legacy callers.
    app.use('/api/modules/analytics', sub);
    app.use('/api/analytics', sub);
  }

  // -------- public ingest routes ('/a/*') --------
  const publicRouter = context?.labeledRouter ? context.labeledRouter('public') : app;

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
    fetchUmamiTracker: async () => {
      const baseUrl = (process.env['UMAMI_BASE_URL'] ?? 'http://umami:3000').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/script.js`);
      return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : '' };
    },
    umamiResolveLink: async (slug, headers) => {
      const baseUrl = (process.env['UMAMI_BASE_URL'] ?? 'http://umami:3000').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/q/${encodeURIComponent(slug)}`, { headers, redirect: 'manual' });
      return { status: res.status, location: res.headers.get('location') };
    },
    decryptSecret: context?.decryptSecret ?? ((b: Buffer | string) => Buffer.isBuffer(b) ? b.toString('utf-8') : (b as string)),
    rateLimit: context?.rateLimit ?? (async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
    logger,
    perIpRpm: getEnvNumber('ANALYTICS_INGEST_PER_IP_RPM', 200),
    perPropertyRpm: getEnvNumber('ANALYTICS_INGEST_PER_PROPERTY_RPM', 5000),
    embedCacheMaxAgeSeconds: getEnvNumber('ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS', 300),
  });

  if (context.labeledRouter) {
    mountIngestRoutes(publicRouter, ingestRoutes);
  } else {
    const sub = Router();
    mountIngestRoutes(sub, ingestRoutes);
    app.use('/', sub);
  }
}
