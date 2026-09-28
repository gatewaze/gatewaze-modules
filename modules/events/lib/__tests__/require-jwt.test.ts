/**
 * Tests for the events module's own auth gate.
 *
 * Why this gate exists: the platform does not gate module routes, and until
 * now `/api/admin/events/*` had no gate of its own — it was protected only
 * because the newsletters and host-media modules each mount a blanket-gated
 * router at `/api/admin`. On a brand installing neither, `bulk-delete` and the
 * full admin listing were reachable unauthenticated. These tests pin the gate
 * so that protection can't quietly regress back to an accident of load order.
 *
 * They also carry the invariants the shared drift-guard cares about (see
 * scripts/check-module-require-jwt.mjs): "cannot verify" must mean 401, never
 * a thrown error, and a decoded-but-unverified payload must never be trusted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { requireJwt, type VerifyClient } from '../require-jwt';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** A syntactically valid JWT with an attacker-chosen alg and a junk signature. */
function tokenWithAlg(alg: string, claims: Record<string, unknown> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url({ alg, typ: 'JWT' })}.${b64url({ sub: 'attacker', exp, ...claims })}.AAAA`;
}

/** A genuinely signed HS256 token. */
function signedHs256(secret: string, claims: Record<string, unknown> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub: 'user-1', exp, ...claims });
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function mockReqRes(token?: string) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} } as never;
  const res = {
    statusCode: 0 as number,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

/** A verify client that accepts every token — stands in for Supabase cloud. */
function acceptingClient(id = 'cloud-user'): VerifyClient {
  return { auth: { getUser: async () => ({ data: { user: { id, email: 'a@b.c' } } }) } };
}

const ENV_KEYS = [
  'SUPABASE_JWT_SECRET',
  'JWT_SECRET',
  'GATEWAZE_TEST_DISABLE_AUTH',
  'NODE_ENV',
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('events requireJwt — denies unauthenticated callers', () => {
  it('401s when no Authorization header is present', async () => {
    const { req, res, next } = mockReqRes();
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      error: { code: 'unauthenticated', message: 'Missing or malformed Authorization header' },
    });
  });

  it('401s on a token that is not three segments', async () => {
    const { req, res, next } = mockReqRes('not.a.jwt.at.all');
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on an HS256 token whose signature does not verify', async () => {
    process.env.JWT_SECRET = 'correct-secret';
    const { req, res, next } = mockReqRes(signedHs256('wrong-secret'));
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on an expired but correctly signed token', async () => {
    process.env.JWT_SECRET = 'correct-secret';
    const expired = signedHs256('correct-secret', { exp: Math.floor(Date.now() / 1000) - 60 });
    const { req, res, next } = mockReqRes(expired);
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: 'token_expired', message: 'JWT verification failed' } });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('events requireJwt — admits verified callers', () => {
  it('calls next() and sets req.userId for a correctly signed HS256 token', async () => {
    process.env.JWT_SECRET = 'correct-secret';
    const { req, res, next } = mockReqRes(signedHs256('correct-secret'));
    await requireJwt(() => null)(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect((req as { userId?: string }).userId).toBe('user-1');
  });

  it('admits a cloud (ES256) token only on the strength of server-side getUser', async () => {
    const { req, res, next } = mockReqRes(tokenWithAlg('ES256'));
    await requireJwt(() => acceptingClient('verified-id'))(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    // The identity comes from Supabase, NOT from the decoded `sub` ('attacker').
    expect((req as { userId?: string }).userId).toBe('verified-id');
  });
});

describe('events requireJwt — "cannot verify" means denied, never a throw', () => {
  it('401s on alg:HS256 when no JWT secret is configured (ES256-only deployment)', async () => {
    // This is how AAIF production runs. getJwtSecret() throws here; an uncaught
    // throw out of async middleware becomes an unhandledRejection, which the
    // api's Sentry hook turns into process.exit(1) — a remote kill-switch.
    const { req, res, next } = mockReqRes(tokenWithAlg('HS256'));
    await expect(requireJwt(() => null)(req, res as never, next)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s on a cloud token when no verify client is available', async () => {
    const { req, res, next } = mockReqRes(tokenWithAlg('ES256'));
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s rather than throwing when the client factory itself throws', async () => {
    // initSupabase() throws when SUPABASE_URL / SERVICE_ROLE_KEY are unset.
    const { req, res, next } = mockReqRes(tokenWithAlg('ES256'));
    const boom = () => {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    };
    await expect(requireJwt(boom)(req, res as never, next)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s rather than throwing when getUser rejects', async () => {
    const { req, res, next } = mockReqRes(tokenWithAlg('ES256'));
    const rejecting: VerifyClient = {
      auth: {
        getUser: async () => {
          throw new Error('network down');
        },
      },
    };
    await expect(requireJwt(() => rejecting)(req, res as never, next)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('events requireJwt — the test bypass cannot be turned on in production', () => {
  it('honours GATEWAZE_TEST_DISABLE_AUTH outside production', async () => {
    process.env.GATEWAZE_TEST_DISABLE_AUTH = '1';
    process.env.NODE_ENV = 'test';
    const { req, res, next } = mockReqRes();
    await requireJwt(() => null)(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores GATEWAZE_TEST_DISABLE_AUTH when NODE_ENV is production', async () => {
    process.env.GATEWAZE_TEST_DISABLE_AUTH = '1';
    process.env.NODE_ENV = 'production';
    const { req, res, next } = mockReqRes();
    await requireJwt(() => null)(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
