// @ts-nocheck — uses jsonwebtoken which requires workspace install.
/**
 * Local requireJwt middleware. We can't cleanly import the platform's
 * `@gatewaze/api/lib/auth/require-jwt` from within a module — the
 * gatewaze-modules workspace isn't linked into the platform's
 * node_modules at runtime — and the platform doesn't apply requireJwt
 * to /api/admin/* itself. So host-media ships its own minimal
 * verification.
 *
 * Behaviour: same contract as the platform's requireJwt — sets
 * `req.userId`, returns 401 on missing/invalid tokens. We DO NOT
 * resolve active-account; the per-kind RLS check downstream
 * (`can_admin_<kind>`) verifies membership.
 */

import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';

// Client used only to verify non-HS256 (cloud ES256) tokens via Supabase Auth — this module gates
// /api/admin/* itself (the platform does not), so it must verify signatures, not trust the payload.
let _verifyClient: ReturnType<typeof createClient> | null = null;
function verifyClient() {
  if (_verifyClient) return _verifyClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _verifyClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _verifyClient;
}

interface SupabaseJwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  role?: string;
  [key: string]: unknown;
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET (or SUPABASE_JWT_SECRET) not set; host-media requireJwt cannot verify tokens');
  }
  return secret;
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    // Split into individual cookies and match the name with string ops — NOT a backtracking regex
    // over the whole Cookie header (which CodeQL flags as polynomial ReDoS on untrusted input).
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

export function requireJwt() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    const decoded = jwt.decode(token, { complete: true }) as
      | { header: { alg?: string }; payload: SupabaseJwtClaims }
      | null;
    if (!decoded?.payload) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }
    const alg = decoded.header.alg;
    let claims: SupabaseJwtClaims = decoded.payload;

    if (alg === 'HS256') {
      try {
        claims = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as SupabaseJwtClaims;
      } catch (err) {
        const code = (err as Error).name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
        errorResponse(res, 401, code, 'JWT verification failed');
        return;
      }
    } else {
      // Non-HS256 (ES256 cloud tokens). This module's requireJwt is the SOLE gate for /api/admin/*
      // (the platform only gates /api/modules/*), so we MUST verify the signature — trusting the
      // decoded payload is an alg-confusion bypass (alg:none / algorithm substitution). Verify against
      // Supabase Auth, which validates the ES256 signature, exactly as the platform's requireJwt does.
      const client = verifyClient();
      if (!client) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
      try {
        const { data, error } = await client.auth.getUser(token);
        if (error || !data?.user?.id) {
          errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
          return;
        }
        // Trust only the server-verified identity (the whole token was verified above, but prefer the
        // authoritative fields from getUser over the decoded payload).
        claims = { ...claims, sub: data.user.id, email: data.user.email ?? claims.email };
      } catch {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
    }

    if (!claims.sub) {
      errorResponse(res, 401, 'invalid_token', 'JWT missing sub claim');
      return;
    }

    (req as Request & { userId?: string; jwtClaims?: SupabaseJwtClaims }).userId = claims.sub;
    (req as Request & { userId?: string; jwtClaims?: SupabaseJwtClaims }).jwtClaims = claims;
    next();
  };
}
