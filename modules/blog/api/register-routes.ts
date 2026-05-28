// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Blog module — apiRoutes entry. Mounts the public read endpoints under
 * /api/blog/*. No JWT required: posts are filtered to
 * status='published' AND visibility='public' so only intentionally-public
 * content is served.
 */

// supabase-js >= 2.50 auto-initialises @supabase/realtime-js which probes
// for a native WebSocket constructor. Node 20 doesn't ship one, and the
// blog module never uses realtime — supply a no-op stand-in so client
// construction doesn't throw. Safe because no subscribe() call is made.
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
import { createPublicBlogRoutes, mountPublicBlogRoutes } from './public-routes.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[blog] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[blog] ${msg}`, meta ?? ''),
  };
}

export function registerRoutes(app: Express): void {
  const logger = defaultLogger();
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const publicRouter = Router();
  const publicRoutes = createPublicBlogRoutes({ supabase, logger });
  mountPublicBlogRoutes(publicRouter, publicRoutes);

  app.use('/api', publicRouter);
  logger.info('blog module routes registered');
}
