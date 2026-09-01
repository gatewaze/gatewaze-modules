// @ts-nocheck — express + supabase-js types are resolved at module-host install time.
/**
 * Local requireJwt for the send-testing-glockapps module.
 *
 * The platform does NOT gate dynamic module routes (`/api/modules/<id>/*` — the
 * platform only labels them; auth is the module author's responsibility, see
 * packages/api/src/server.ts). So this middleware is the SOLE authentication
 * gate for send-testing-glockapps' admin API, which can write people rows and
 * spend against a paid third-party API. It must verify token signatures — trusting an unverified
 * payload is an alg-confusion bypass (alg:none / algorithm substitution).
 *
 * Verification, mirroring the platform's own requireJwt contract:
 *   - HS256 (dev / self-host): verify the HMAC signature with the shared secret
 *     using Node's built-in crypto (no `jsonwebtoken` dep, which the module dir
 *     isn't guaranteed to have linked).
 *   - Non-HS256 (ES256 cloud tokens): verify server-side via Supabase Auth
 *     (`auth.getUser`), which checks the ES256 signature. This is the correct,
 *     cloud-safe path — do NOT require an "upstream" userId (there is no
 *     upstream gate for module routes), and never trust the decoded payload.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';

interface SupabaseJwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  role?: string;
  [key: string]: unknown;
}

// Client used only to verify non-HS256 (cloud ES256) tokens via Supabase Auth.
let _verifyClient: ReturnType<typeof createClient> | null = null;
function verifyClient() {
  if (_verifyClient) return _verifyClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _verifyClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _verifyClient;
}

function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT secret (SUPABASE_JWT_SECRET/JWT_SECRET) not set; send-testing-glockapps requireJwt cannot verify tokens');
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
    // Split into individual cookies and match by name with string ops — NOT a
    // backtracking regex over the whole (untrusted) Cookie header.
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

function b64urlToJson<T>(seg: string): T | null {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Verify an HS256 signature over `${headerB64}.${payloadB64}` in constant time. */
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
    const parts = token.split('.');
    if (parts.length !== 3) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const header = b64urlToJson<{ alg?: string }>(headerB64);
    let claims = b64urlToJson<SupabaseJwtClaims>(payloadB64);
    if (!header || !claims) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }

    if (header.alg === 'HS256') {
      if (!verifyHs256(`${headerB64}.${payloadB64}`, signatureB64, getJwtSecret())) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
    } else {
      // Non-HS256 (ES256 cloud tokens): verify the signature server-side via
      // Supabase Auth. Never trust the decoded payload (alg-confusion bypass).
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
        // Trust only the server-verified identity.
        claims = { ...claims, sub: data.user.id, email: data.user.email ?? claims.email };
      } catch {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
    }

    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
      errorResponse(res, 401, 'token_expired', 'JWT expired');
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
