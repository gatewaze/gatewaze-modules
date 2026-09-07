/**
 * Regression tests for the module's sole auth gate.
 *
 * The bug these pin down: `alg` is attacker-controlled and read before any
 * verification. On an ES256-only deployment (Supabase cloud — no JWT secret
 * set, which is how AAIF production runs) an unauthenticated `alg: HS256`
 * request drove `getJwtSecret()`, which throws. Express 4 does not catch
 * rejections from async middleware, so the throw became an unhandledRejection,
 * and the platform api's Sentry hook turns that into `process.exit(1)` — a
 * remote, unauthenticated kill-switch for the whole api process.
 *
 * "Cannot verify" must mean "not verified" (401), never a thrown error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requireJwt } from '../lib/require-jwt';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** A syntactically valid JWT with an attacker-chosen alg and a junk signature. */
function tokenWithAlg(alg: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url({ alg, typ: 'JWT' })}.${b64url({ sub: 'attacker', exp })}.AAAA`;
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

const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'GATEWAZE_TEST_DISABLE_AUTH', 'NODE_ENV'] as const;
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

describe('requireJwt — no throw escapes the gate', () => {
  it('answers 401 for alg:HS256 when no JWT secret is configured (ES256-only deployment)', async () => {
    const { req, res, next } = mockReqRes(tokenWithAlg('HS256'));

    // Must resolve, not reject. A rejection here is the process-killing bug.
    await expect(requireJwt()(req, res as never, next)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a non-HS256 token when no verification client is configured', async () => {
    const { req, res, next } = mockReqRes(tokenWithAlg('ES256'));

    await expect(requireJwt()(req, res as never, next)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 with no Authorization header', async () => {
    const { req, res, next } = mockReqRes();

    await requireJwt()(req, res as never, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireJwt — test-only bypass is not reachable in production', () => {
  it('ignores GATEWAZE_TEST_DISABLE_AUTH when NODE_ENV=production', async () => {
    process.env.GATEWAZE_TEST_DISABLE_AUTH = '1';
    process.env.NODE_ENV = 'production';
    const { req, res, next } = mockReqRes();

    await requireJwt()(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('honours GATEWAZE_TEST_DISABLE_AUTH outside production', async () => {
    process.env.GATEWAZE_TEST_DISABLE_AUTH = '1';
    process.env.NODE_ENV = 'test';
    const { req, res, next } = mockReqRes();

    await requireJwt()(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
