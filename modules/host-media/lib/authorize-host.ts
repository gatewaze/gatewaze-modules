// @ts-nocheck — uses @supabase/supabase-js which requires workspace install.
/**
 * Per-host authorization for the /api/admin/<hostKind>/:hostId/* routes.
 *
 * requireJwt() only proves the caller has a valid Supabase session. The
 * route handlers then use a service-role client (Storage writes need
 * it), which bypasses RLS — so without this check any signed-in user,
 * including a portal account, could list, edit or delete any host's
 * media. This middleware asks the database, AS THE CALLER, whether they
 * may administer the host: can_admin_host_media() dispatches to the
 * consumer's can_admin_<kind>() predicate (migration 008).
 *
 * Fails closed: missing anon key, RPC error, or anything but `true`
 * denies the request.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isKnownHostKind } from './registry.js';
import { paramAsString, paramAsUuid } from './sanitisers.js';
import { extractToken } from './extract-token.js';

interface PlatformLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface HostAuthorizerDeps {
  supabaseUrl: string;
  anonKey: string;
  logger: PlatformLogger;
  /** Test seam — returns whether the caller may administer the host. */
  canAdmin?: (token: string, hostKind: string, hostId: string) => Promise<boolean>;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createHostAuthorizer(deps: HostAuthorizerDeps): RequestHandler {
  const { supabaseUrl, anonKey, logger } = deps;

  const canAdmin = deps.canAdmin ?? (async (token: string, hostKind: string, hostId: string) => {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.rpc('can_admin_host_media', {
      p_host_kind: hostKind,
      p_host_id: hostId,
    });
    if (error) {
      logger.error('can_admin_host_media failed', { hostKind, hostId, error: error.message });
      return false;
    }
    return data === true;
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hostKind = paramAsString(req.params['hostKind']);
      const hostId = paramAsUuid(req.params['hostId']);
      if (!hostKind || !hostId || !isKnownHostKind(hostKind)) {
        sendError(res, 400, 'invalid_params', 'valid hostKind + hostId required');
        return;
      }
      // Same test-only bypass as requireJwt(); NODE_ENV-guarded.
      if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1' && process.env.NODE_ENV !== 'production') {
        next();
        return;
      }
      if (!deps.canAdmin && (!supabaseUrl || !anonKey)) {
        logger.error('SUPABASE_ANON_KEY not set; denying host-media admin request');
        sendError(res, 503, 'auth_unavailable', 'authorization is not configured');
        return;
      }
      const token = extractToken(req);
      if (!token) {
        sendError(res, 401, 'unauthenticated', 'session required');
        return;
      }
      if (!(await canAdmin(token, hostKind, hostId))) {
        sendError(res, 403, 'forbidden', `not permitted to manage media for this ${hostKind}`);
        return;
      }
      next();
    } catch (err) {
      // Express 4 does not catch async middleware rejections; degrade to
      // "denied", never to an unhandledRejection.
      logger.error('host authorizer threw; denying request', {
        error: err instanceof Error ? err.message : String(err),
      });
      try { sendError(res, 403, 'forbidden', 'authorization failed'); } catch { /* already sent */ }
    }
  };
}
