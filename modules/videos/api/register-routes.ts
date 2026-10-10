// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Videos module — apiRoutes entry.
 *
 * Two surfaces with deliberately different trust:
 *
 *   /api/videos/*                  public reads, no JWT, filtered to
 *                                  status='published' AND visibility='public'
 *   /api/modules/videos/editor/*   the video editor workflow, behind the
 *                                  platform's JWT prefix, with every handler
 *                                  authorising per subject as the CALLER
 *
 * The second one is why `userClient` exists below. The permission check must
 * run with the caller's own token so the SECURITY DEFINER predicate sees their
 * auth.uid(); running it with the service role would evaluate auth.uid() as
 * null and deny everyone.
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

import { Router, json, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createPublicVideoRoutes, mountPublicVideoRoutes } from './public-routes.js';
import { mountEditorRoutes } from './editor-routes.js';

interface RegisterCtx {
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }>;
}

export function registerRoutes(app: Express, ctx?: RegisterCtx): void {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`[videos] ${msg}`, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[videos] ${msg}`, meta ?? ''),
  };

  const publicRouter = Router();
  mountPublicVideoRoutes(publicRouter, createPublicVideoRoutes({ supabase }));
  app.use('/api', publicRouter);

  if (!supabaseAnonKey) {
    logger.warn('SUPABASE_ANON_KEY not set — the editor endpoints will refuse every request');
  }

  // Parsed without a regex: /^Bearer\s+(.+)$/ backtracks polynomially on a
  // header of "bearer " followed by many spaces, and this value comes off an
  // attacker-controlled request header.
  const BEARER = 'bearer ';
  const extractBearer = (req: { headers?: Record<string, unknown> }): string | null => {
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    if (typeof raw !== 'string' || raw.length <= BEARER.length) return null;
    if (raw.slice(0, BEARER.length).toLowerCase() !== BEARER) return null;
    const token = raw.slice(BEARER.length).trim();
    return token || null;
  };

  const userClient = (req) => {
    if (!supabaseAnonKey) return null;
    const token = extractBearer(req as never);
    if (!token) return null;
    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  };

  const editorRouter = Router();
  // The editor endpoints exchange small JSON only: the file bytes go straight
  // to storage on a signed URL. 256kb is plenty for a 20-file mint and keeps
  // this router far below the server's global 50mb limit.
  editorRouter.use(json({ limit: '256kb' }));
  mountEditorRoutes(editorRouter, {
    supabase,
    userClient,
    logger,
    ...(ctx?.enqueueJob && { enqueueJob: ctx.enqueueJob }),
  });
  app.use('/api/modules/videos', editorRouter);

  console.log('[videos] module routes registered (public reads + editor workflow)');
}
