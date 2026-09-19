// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.

/**
 * Event-media module — apiRoutes entry (first server routes this module
 * has owned since it became a host-media consumer).
 *
 * Mounts:
 *   - Public guest-upload endpoints under /api/public/event-media/*
 *     (no JWT; the upload-link short code is the authorization;
 *     IP-rate-limited before resolution).
 *   - Admin link CRUD under /api/admin/events/:eventId/media-upload-links
 *     behind host-media's requireJwt — the platform does NOT gate
 *     /api/admin/* itself, so that local gate is the sole auth wall.
 *
 * Auth helpers are reused from the sibling host-media checkout via a
 * relative dynamic import — the same shape events/index.ts already uses
 * for host-media's consumer registry.
 *
 * Per spec-event-media-guest-uploads §5.
 */

import type { ModuleContext } from '@gatewaze/shared';
import { Router, type Express, type Request } from 'express';
import { createClient } from '@supabase/supabase-js';

import { createGuestRoutes, mountGuestRoutes } from './public-guest-routes.js';
import { createAdminLinksRoutes, mountAdminLinksRoutes } from './admin-links-routes.js';

const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[event-media] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[event-media] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[event-media] ${msg}`, meta ?? ''),
  };
}

interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: number }>;
}

function defaultRateLimiter(): RateLimiter {
  // In-memory sliding window (same posture as host-media). Adequate for
  // the small API replica counts these public endpoints run behind; the
  // per-link hourly circuit breaker is deliberately generous so replica
  // skew cannot lock out a legitimate wedding crowd.
  const buckets = new Map<string, number[]>();
  // Stale keys must be reaped, not just their arrays filtered —
  // client_id is caller-supplied, so without eviction the map grows
  // without bound over process uptime (security review 2026-09-19).
  const MAX_WINDOW_MS = 3_600_000; // largest window used (per-link hourly cap)
  let lastSweep = Date.now();
  function sweep(now: number): void {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.length === 0 || now - bucket[bucket.length - 1]! > MAX_WINDOW_MS) {
        buckets.delete(key);
      }
    }
  }
  return {
    async check(key, max, windowMs) {
      const now = Date.now();
      sweep(now);
      const bucket = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (bucket.length >= max) {
        return { allowed: false, resetAt: bucket[0]! + windowMs };
      }
      bucket.push(now);
      buckets.set(key, bucket);
      return { allowed: true, resetAt: now + windowMs };
    },
  };
}

/** Extract the caller's bearer token (Authorization header, or the
 *  Supabase auth cookie) so admin routes can run table ops AS the
 *  caller — real RLS instead of service-role bypass. */
function extractBearer(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      if (!name.startsWith('sb-') || !name.endsWith('-auth-token')) continue;
      try {
        const parsed = JSON.parse(decodeURIComponent(part.slice(eq + 1).trim())) as { access_token?: string };
        if (parsed.access_token) return parsed.access_token;
      } catch {
        // malformed cookie → keep scanning
      }
    }
  }
  return null;
}

export async function registerRoutes(app: Express, context?: ModuleContext): Promise<void> {
  const logger = defaultLogger();
  const rateLimiter = defaultRateLimiter();

  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — guest upload endpoints will fail');
  }
  const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Browsers can't resolve the in-cluster SUPABASE_URL hostname —
  // public/signed URLs handed to them must use the external one.
  const publicSupabaseUrl = (process.env.SUPABASE_PUBLIC_URL || supabaseUrl).replace(/\/+$/, '');

  // Public guest endpoints — /api/public/event-media/*.
  const publicRouter = Router();
  const guestRoutes = createGuestRoutes({
    supabase: serviceSupabase,
    storageBucket: STORAGE_BUCKET,
    publicSupabaseUrl,
    internalSupabaseUrl: supabaseUrl,
    rateLimit: rateLimiter.check.bind(rateLimiter),
    logger,
  });
  mountGuestRoutes(publicRouter, guestRoutes);
  app.use('/api', publicRouter);

  // Admin link CRUD — /api/admin/events/:eventId/media-upload-links,
  // behind host-media's requireJwt (relative dynamic import; the same
  // cross-module shape events/index.ts uses for the consumer registry).
  const { requireJwt } = await import('../../host-media/lib/require-jwt.js');
  const adminRouter = Router();
  adminRouter.use(requireJwt());
  const adminRoutes = createAdminLinksRoutes({
    userClient: (req) => {
      if (!supabaseAnonKey) return null;
      const token = extractBearer(req);
      if (!token) return null;
      return createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
    },
    logger,
  });
  mountAdminLinksRoutes(adminRouter, adminRoutes);
  app.use('/api/admin', adminRouter);

  void context;
  logger.info('event-media module routes registered');
}
