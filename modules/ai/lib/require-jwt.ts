// @ts-nocheck — express + supabase-js types are resolved at module-host install time.
/**
 * Signature-verifying auth gate for the ai module's admin routes.
 *
 * The platform does NOT gate dynamic module routes (`/api/modules/<id>/*`),
 * so this middleware is the sole authentication gate for the ai admin
 * surface (credentials, use cases, usage).
 *
 * ONE verification path for every token algorithm: Supabase Auth checks the
 * signature server-side (HS256 self-host and ES256 cloud alike) via
 * `auth.getUser(token)`. No branching on attacker-controlled header fields
 * (CodeQL js/user-controlled-bypass), and the decoded payload is never
 * trusted directly. The middleware never throws: every failure path answers
 * 401 — an auth bug must degrade to "denied", not to a crashed api process.
 */

import { createClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';

// Client used only to verify tokens via Supabase Auth.
let _verifyClient: ReturnType<typeof createClient> | null = null;
function verifyClient() {
  if (_verifyClient) return _verifyClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _verifyClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _verifyClient;
}

function extractToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (header && header.startsWith('Bearer ') && header.length > 7) {
    return header.slice(7).trim() || null;
  }
  return null;
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function requireJwt() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1') {
        (req as Request & { userId?: string }).userId = '00000000-0000-0000-0000-000000000001';
        next();
        return;
      }
      const token = extractToken(req);
      if (!token) {
        errorResponse(res, 401, 'unauthenticated', 'Missing or malformed Authorization header');
        return;
      }
      const client = verifyClient();
      if (!client) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
      const { data, error } = await client.auth.getUser(token);
      const sub = data?.user?.id;
      if (error || !sub) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
      (req as Request & { userId?: string }).userId = sub;
      next();
    } catch {
      // Absolute backstop: an auth-path bug answers 401, never crashes the api.
      try { errorResponse(res, 401, 'invalid_token', 'JWT verification failed'); } catch { /* headers sent */ }
    }
  };
}
