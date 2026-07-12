// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Videos module — apiRoutes entry. Mounts public read endpoints under
 * /api/videos/*. No JWT required: videos are filtered to status='published'
 * AND visibility='public'.
 */

// supabase-js >= 2.50 auto-initialises realtime which probes for a native
// WebSocket; Node doesn't ship one and the module never uses realtime.
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
import { createPublicVideoRoutes, mountPublicVideoRoutes } from './public-routes.js';

export function registerRoutes(app: Express): void {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const publicRouter = Router();
  mountPublicVideoRoutes(publicRouter, createPublicVideoRoutes({ supabase }));
  app.use('/api', publicRouter);
  console.log('[videos] module routes registered');
}
