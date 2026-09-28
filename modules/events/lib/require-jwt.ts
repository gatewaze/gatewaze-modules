// @ts-nocheck — express types resolved at module-host install time.
/**
 * Local requireJwt middleware for the events module.
 *
 * The events module registers routes under `/api/admin/events/*`, and the
 * platform does NOT gate module routes — `assertAllRoutesLabeled()` explicitly
 * exempts them and leaves auth to the module author. Until now these routes had
 * no gate of their own; they were protected only as a side effect of the
 * newsletters and host-media modules each mounting a router at `/api/admin`
 * with `router.use(requireJwt())`, which blanket-gates the whole prefix. On a
 * brand without those two modules installed, the events admin surface —
 * including `bulk-delete` — was reachable unauthenticated. This is the module's
 * own gate so its auth no longer depends on a sibling being present.
 *
 * Mirrors modules/vehicle-video/lib/require-jwt.ts (the reference copy named by
 * scripts/check-module-require-jwt.mjs), with one deliberate difference: the
 * Supabase client used to verify cloud tokens is INJECTED rather than built from
 * a bare `@supabase/supabase-js` import. Route code in this module resolves that
 * package through `createRequire(<projectRoot>/packages/api/package.json)`
 * because the module dir has no node_modules of its own at runtime; a bare
 * import here would resolve at load time in some hosts and not others.
 *
 * Behaviour: sets `req.userId`, returns 401 on missing/invalid/expired tokens.
 *   - HS256 (dev / self-host): verify the HMAC signature + expiry with Node's
 *     built-in crypto (the real gate).
 *   - Non-HS256 (ES256 cloud tokens): verify server-side via Supabase Auth
 *     (`auth.getUser`), which checks the ES256 signature — never trust the
 *     decoded payload, which would be an alg-confusion bypass.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** Minimal shape we need from a Supabase client — just cloud-token verification. */
export interface VerifyClient {
  auth: {
    getUser(token: string): Promise<{
      data?: { user?: { id?: string; email?: string } | null } | null;
      error?: unknown;
    }>;
  };
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
  res.status(status).json({ error: { code, message } });
}

function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET (or SUPABASE_JWT_SECRET) not set; events requireJwt cannot verify tokens');
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
    // over the whole header (which CodeQL flags as polynomial ReDoS on the untrusted Cookie header).
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

/**
 * Build the gate. `getVerifyClient` is called lazily, per cloud-token request,
 * and may return null (or throw) when Supabase isn't configured — that is
 * treated as "cannot verify" and therefore "denied".
 */
export function requireJwt(getVerifyClient: () => VerifyClient | null) {
  const gate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Test-only bypass. Guarded on NODE_ENV so a stray env var in a real
    // deployment cannot disable authentication.
    if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1' && process.env.NODE_ENV !== 'production') {
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
      // `alg` is attacker-controlled and is read before any verification, so on
      // an ES256-only deployment (no JWT secret set — e.g. Supabase cloud) any
      // unauthenticated caller can drive execution down this branch.
      // getJwtSecret() throws there, so it must not be called bare: treat
      // "cannot verify" as "not verified", matching the ES256 branch below.
      let secret: string;
      try {
        secret = getJwtSecret();
      } catch {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
      if (!verifyHs256(`${headerB64}.${payloadB64}`, signatureB64, secret)) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
    } else {
      // Non-HS256 (ES256 cloud tokens): we hold only the HS256 shared secret and
      // cannot check the signature locally. Verify server-side via Supabase Auth
      // (which validates the ES256 signature) — never trust the decoded payload
      // (that would be an alg-confusion bypass).
      let client: VerifyClient | null = null;
      try {
        client = getVerifyClient();
      } catch {
        client = null;
      }
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

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await gate(req, res, next);
    } catch (err) {
      // Never silent: the gate throwing at all is a bug worth a signal.
      console.error('[events requireJwt] auth gate threw; denying request', err);
      // Absolute backstop. This is the module's own auth gate and Express 4
      // does not catch rejections from async middleware, so an uncaught throw
      // becomes an unhandledRejection — which the platform api's Sentry hook
      // turns into process.exit(1). A bug on this path must degrade to
      // "denied", never to a dead api process.
      try {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      } catch {
        // response already sent — nothing further to do
      }
    }
  };
}
