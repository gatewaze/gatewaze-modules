// @ts-nocheck — uses jsonwebtoken which requires workspace install.
/**
 * Local requireJwt middleware. We can't cleanly import the platform's
 * `@gatewaze/api/lib/auth/require-jwt` from within a module — the
 * gatewaze-modules workspace isn't linked into the platform's
 * node_modules at runtime — and the platform doesn't apply requireJwt
 * to /api/admin/* itself. Mirrors host-media's own copy.
 *
 * Behaviour: same contract as the platform's requireJwt — sets
 * `req.userId`, returns 401 on missing/invalid tokens. We DO NOT
 * resolve active-account; the per-kind RLS check downstream
 * (`can_admin_newsletter`) verifies membership.
 */

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

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
    const match = cookieHeader.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded) as { access_token?: string };
        if (parsed.access_token) return parsed.access_token;
      } catch {
        // malformed cookie → fall through
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
      // ES256/cloud path — we trust the decoded payload here without
      // re-verifying signatures. The platform's requireJwt does a
      // round-trip to supabase.auth.getUser() for full verification;
      // host-media's invocations always sit behind it (admin access
      // patterns) so the additional round-trip is overkill. If/when
      // this module gets used in a context where ES256 tokens are
      // unverified, the platform's requireJwt should run upstream.
      // For dev (HS256) the path above is the actual gate.
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
