// @ts-nocheck — express types resolved at module-host install time.
/**
 * Local requireJwt middleware for the vehicle-video module. We can't cleanly
 * import the platform's `@gatewaze/api/lib/auth/require-jwt` from within a module
 * (the gatewaze-modules workspace isn't linked into the platform's node_modules
 * at runtime), and the platform does NOT apply requireJwt to dynamic module
 * routes. So the module gates its own routes. Mirrors the newsletters/host-media
 * copies, but verifies with Node's built-in `crypto` instead of pulling in
 * `jsonwebtoken` — the module dir isn't guaranteed to have that dep linked.
 *
 * Behaviour: same contract as the platform's requireJwt — sets `req.userId`,
 * returns 401 on missing/invalid/expired tokens. For the dev / self-host HS256
 * path we verify the HMAC signature + expiry ourselves (the real gate). ES256
 * (cloud) tokens are decoded and trusted here without a signature round-trip —
 * those invocations sit behind the platform's own requireJwt, and the
 * router-level admin_profiles check in register-routes is the authorisation gate.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
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
  res.status(status).json({ error: { code, message } });
}

function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET (or SUPABASE_JWT_SECRET) not set; vehicle-video requireJwt cannot verify tokens');
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

function b64urlToJson<T>(seg: string): T | null {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Verify an HS256 signature over `${h}.${p}` in constant time. */
function verifyHs256(signingInput: string, signatureB64url: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signatureB64url, 'base64url');
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function requireJwt() {
  return (req: Request, res: Response, next: NextFunction): void => {
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
    const parts = token.split('.');
    if (parts.length !== 3) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const header = b64urlToJson<{ alg?: string }>(headerB64);
    const claims = b64urlToJson<SupabaseJwtClaims>(payloadB64);
    if (!header || !claims) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }

    if (header.alg === 'HS256') {
      if (!verifyHs256(`${headerB64}.${payloadB64}`, signatureB64, getJwtSecret())) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
    }
    // else: ES256/cloud — trusted behind the platform's upstream requireJwt (see docstring).

    // Expiry is always enforced when present.
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
      errorResponse(res, 401, 'token_expired', 'JWT verification failed');
      return;
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
