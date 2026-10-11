// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Videos module — apiRoutes entry.
 *
 * Two surfaces with deliberately different trust:
 *
 *   /api/videos/*          public reads, no JWT, filtered to
 *                          status='published' AND visibility='public'
 *   /api/video-editor/*    the video editor workflow: authenticates the caller
 *                          itself, then authorises per subject
 *
 * Why not /api/modules/videos/* like the other modules? Because the platform
 * mounts its own router at /api/modules and that router applies
 * requireSuperAdmin() to everything except /internal/* (see
 * packages/api/src/routes/modules.ts, "Module management is super_admin
 * only"). A module adding a sub-path under it inherits that gate, so a
 * third-party video editor would get 403 forever. Verified by getting exactly
 * that 403 from a real editor account before moving the mount.
 *
 * The consequence is that this prefix has NO platform auth in front of it, so
 * every handler must authenticate as well as authorise. `requireUser` below
 * is that first half, and `userClient` is the second: the permission check
 * runs with the caller's own token so the SECURITY DEFINER predicate sees
 * their auth.uid(). Running it with the service role would evaluate auth.uid()
 * as null and deny everyone.
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
import { rateLimit } from 'express-rate-limit';
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
  // Unauthenticated reads, so the only thing bounding a caller is this. The
  // ceiling is generous because a single portal page can fan out to several
  // video lookups; it exists to stop a scripted sweep of the whole table.
  publicRouter.use(rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'too many requests' },
  }));
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

  // Rate limiter FIRST, body parser and auth after it.
  //
  // Two reasons for that order. The throttle has to cover the token
  // verification in `requireUser` below, which is a round trip to Supabase on
  // every request and is therefore the expensive part an unauthenticated
  // caller can make us do. And this prefix has no platform middleware in front
  // of it at all, so if the limiter sat behind the auth check, a flood of
  // bad tokens would never reach it.
  //
  // 240 a minute per IP is the same ceiling event-media's admin router uses. An
  // editor minting twenty files at once spends one request, so a real session
  // is nowhere near it.
  editorRouter.use(rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'too many requests' },
  }));

  // The editor endpoints exchange small JSON only: the file bytes go straight
  // to storage on a signed URL. 256kb is plenty for a 20-file mint and keeps
  // this router far below the server's global 50mb limit.
  editorRouter.use(json({ limit: '256kb' }));

  /**
   * Authenticate, before any handler authorises.
   *
   * This prefix has no platform JWT middleware in front of it (see the header
   * comment), so a bare request would otherwise reach a handler and rely on
   * the authorisation RPCs returning false for a null session. They do, but
   * depending on that is depending on the failure mode of two other systems.
   * Rejecting an absent or unresolvable token here makes it one decision.
   */
  const requireUser = async (req, res, next) => {
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'authorization bearer token required' });
      return;
    }
    try {
      const { data, error } = await asUser.auth.getUser();
      if (error || !data?.user?.id) {
        res.status(401).json({ error: 'invalid or expired session' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'could not verify session' });
      return;
    }
    next();
  };
  editorRouter.use(requireUser);

  mountEditorRoutes(editorRouter, {
    supabase,
    userClient,
    logger,
    ...(ctx?.enqueueJob && { enqueueJob: ctx.enqueueJob }),
  });
  // Mounted BEFORE the public router would be a collision risk under
  // /api/videos/:id, so it gets its own prefix instead.
  app.use('/api/video-editor', editorRouter);

  console.log('[videos] module routes registered (public reads + editor workflow)');
}
