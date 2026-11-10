/**
 * The connect flow end to end over HTTP: start → begin → callback, and the
 * settings routes. A real Express server; the database and Google are fakes.
 *
 * The point is the binding. A Google consent URL is only finishable in the
 * browser that /oauth/begin set its cookie on, once, within ten minutes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');
process.env.GATEWAZE_SECRETS_KEY = KEY;
process.env.API_URL = 'https://api.example.test';

const db = {
  config: {} as Record<string, unknown>,
  upserts: [] as unknown[],
  /** Force the next installed_modules read or the connections read to fail. */
  failRead: false,
  failConnections: false,
};

vi.mock('../lib/service-client.js', () => {
  function chain(table: string) {
    const st: { op: string; payload?: unknown } = { op: 'select' };
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => b,
      update: (p: unknown) => { st.op = 'update'; st.payload = p; return b; },
      upsert: (p: unknown) => { db.upserts.push(p); st.op = 'upsert'; return b; },
      maybeSingle: () => b,
      then: (resolve: (v: unknown) => void) => {
        if (table === 'installed_modules' && st.op === 'update') {
          db.config = (st.payload as { config: Record<string, unknown> }).config;
          return resolve({ data: null, error: null });
        }
        if (table === 'installed_modules') {
          if (db.failRead) return resolve({ data: null, error: { message: 'boom' } });
          return resolve({ data: { config: db.config }, error: null });
        }
        if (table === 'video_platform_connections' && st.op === 'select' && db.failConnections) {
          return resolve({ data: null, error: { message: 'relation "secret_internal_table" does not exist' } });
        }
        if (table === 'video_channel_profiles') return resolve({ data: null, error: null });
        return resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { serviceClient: () => ({ from: chain }) };
});

vi.mock('../lib/oauth.js', async (orig) => {
  const real = await orig<typeof import('../lib/oauth.js')>();
  return {
    ...real,
    exchangeCode: vi.fn(async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: 0, scopes: ['s'] })),
    fetchChannel: vi.fn(async () => ({ id: 'UCG6qpjVnBTTT8wLGBygANOQ', title: 'AAIF Live' })),
  };
});

const { registerRoutes } = await import('../api/register-routes.js');
const { sealSecret } = await import('../lib/secret-envelope.js');
const { CLIENT_ID_RE } = await import('../lib/settings.js');
const manifest = (await import('../index.js')).default;

let base = '';
let server: ReturnType<express.Express['listen']>;
const CLIENT_ID = '141648865687-57gl4d6ck3uogo66k95jghtsrludlo4c.apps.googleusercontent.com';
const MOD = '/api/modules/videos-publisher-youtube';
const PUB = '/api/videos-publisher-youtube';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRoutes(app as any);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  process.env.GATEWAZE_SECRETS_KEY = KEY;
  db.config = { clientId: CLIENT_ID, clientSecret: sealSecret('GOCSPX-abcdefghijkl'), otherKey: 'kept' };
  db.upserts = [];
  db.failRead = false;
  db.failConnections = false;
});
afterEach(() => {
  vi.useRealTimers();
});

const put = (body: unknown) =>
  fetch(`${base}${MOD}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function startAndBegin() {
  const start = await (await fetch(`${base}${MOD}/oauth/start`)).json();
  const begin = new URL(start.authorize_url);
  expect(begin.pathname).toBe(`${PUB}/oauth/begin`);
  const ticketUrl = `${base}${begin.pathname}${begin.search}`;
  const res = await fetch(ticketUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  return {
    ticketUrl,
    res,
    state: location ? new URL(location).searchParams.get('state')! : '',
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0],
  };
}

const callback = (state: string, cookie?: string) =>
  fetch(`${base}${PUB}/oauth/callback?state=${encodeURIComponent(state)}&code=c`, {
    headers: cookie ? { cookie } : {},
  });

describe('settings', () => {
  it('seals the secret, stores only known fields, and never returns the secret', async () => {
    db.config = {};
    const r = await put({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-newsecretvalue', isAdmin: true });
    expect(r.status).toBe(200);
    expect(String(db.config.clientSecret)).toMatch(/^v1:/);
    expect(db.config).not.toHaveProperty('isAdmin');

    const got = await (await fetch(`${base}${MOD}/settings`)).json();
    expect(got).toMatchObject({ clientId: CLIENT_ID, clientSecretSet: true, clientSecretReadable: true });
    expect(JSON.stringify(got)).not.toContain('GOCSPX');
    expect(JSON.stringify(got)).not.toContain('v1:');
    expect(got.redirectUri).toBe('https://api.example.test/api/videos-publisher-youtube/oauth/callback');
  });

  it('saves the same client ID without a secret, keeping the stored one', async () => {
    const before = db.config.clientSecret;
    const r = await put({ clientId: CLIENT_ID });
    expect(r.status).toBe(200);
    expect(db.config.clientSecret).toBe(before);
  });

  it('refuses a new client ID without its secret, and writes nothing', async () => {
    const before = { ...db.config };
    const r = await put({ clientId: '999-other.apps.googleusercontent.com' });
    expect(r.status).toBe(400);
    expect(db.config).toEqual(before);
  });

  it('keeps the client ID and other config on a secret-only save', async () => {
    const r = await put({ clientSecret: 'GOCSPX-rotatedsecret1' });
    expect(r.status).toBe(200);
    expect(db.config).toMatchObject({ clientId: CLIENT_ID, otherKey: 'kept' });
  });

  it('answers 400 to a body it cannot accept', async () => {
    expect((await put({ clientId: 'nope' })).status).toBe(400);
  });

  it('refuses to store a secret it cannot seal', async () => {
    const before = { ...db.config };
    delete process.env.GATEWAZE_SECRETS_KEY;
    const r = await put({ clientSecret: 'GOCSPX-cannotseal123' });
    expect(r.status).toBe(503);
    expect(db.config).toEqual(before);
  });

  it('reports a stored secret that can no longer be decrypted', async () => {
    process.env.GATEWAZE_SECRETS_KEY = OTHER_KEY;
    db.config.clientSecret = sealSecret('GOCSPX-abcdefghijkl');
    process.env.GATEWAZE_SECRETS_KEY = KEY;
    const got = await (await fetch(`${base}${MOD}/settings`)).json();
    expect(got).toMatchObject({ clientSecretSet: true, clientSecretReadable: false });
  });

  it('answers 500 without detail when the settings cannot be read', async () => {
    db.failRead = true;
    const r = await put({ clientSecret: 'GOCSPX-abcdefghijkl' });
    expect(r.status).toBe(500);
  });

  it('answers a failed settings read as a failure, not as "not configured"', async () => {
    db.failRead = true;
    const got = await fetch(`${base}${MOD}/settings`);
    expect(got.status).toBe(500);
    const start = await fetch(`${base}${MOD}/oauth/start`);
    expect(start.status).toBe(500);
    expect(await start.text()).not.toContain('not configured');
  });

  it('does not leak a database error from the connections list', async () => {
    db.failConnections = true;
    const r = await fetch(`${base}${MOD}/connections`);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('secret_internal_table');
  });

  it('declares the same client ID rule, and an encrypted secret, in the manifest', () => {
    const schema = manifest.configSchema as Record<string, { validationRegex?: string; type: string; encrypted?: boolean }>;
    expect(schema.clientId.validationRegex).toBe(CLIENT_ID_RE.source);
    expect(schema.clientSecret).toMatchObject({ type: 'secret', encrypted: true });
  });
});

describe('route placement', () => {
  it.each([
    ['GET', `${PUB}/oauth/start`],
    ['GET', `${PUB}/settings`],
    ['PUT', `${PUB}/settings`],
    ['GET', `${PUB}/connections`],
    ['GET', `${MOD}/oauth/callback?state=x&code=y`],
  ])('%s %s is not served (super_admin routes stay under /api/modules; the callback stays out)', async (method, path) => {
    const r = await fetch(`${base}${path}`, { method });
    expect(r.status).toBe(404);
  });
});

describe('connect flow', () => {
  it('sets a cookie scoped to the flow, then sends the browser to Google', async () => {
    const { res, state } = await startAndBegin();
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).host).toBe('accounts.google.com');
    expect(state).toBeTruthy();
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\/api\/videos-publisher-youtube(;|$)/);
    expect(setCookie).toMatch(/Max-Age=600/);
  });

  it('connects the channel when the cookie matches', async () => {
    const { state, cookie } = await startAndBegin();
    const ok = await callback(state, cookie);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('AAIF Live is connected.');
    expect(db.upserts).toHaveLength(1);
    expect(JSON.stringify(db.upserts[0])).not.toContain('"rt"');
    expect(ok.headers.get('set-cookie')).toMatch(/gw_yt_oauth_bind=;/);
  });

  it('refuses the state without the cookie (someone else’s browser)', async () => {
    const { state } = await startAndBegin();
    expect((await callback(state)).status).toBe(403);
    expect(db.upserts).toHaveLength(0);
  });

  it('refuses the state with a cookie of the attacker’s own choosing', async () => {
    const { state } = await startAndBegin();
    expect((await callback(state, 'gw_yt_oauth_bind=attacker-chosen-value')).status).toBe(403);
    expect(db.upserts).toHaveLength(0);
  });

  it('refuses a state it never issued, even with a real cookie', async () => {
    const { cookie } = await startAndBegin();
    const r = await callback('made-up-state', cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('not issued by this server');
    expect(db.upserts).toHaveLength(0);
  });

  it('refuses a replayed state and cookie', async () => {
    const { state, cookie } = await startAndBegin();
    expect((await callback(state, cookie)).status).toBe(200);
    expect((await callback(state, cookie)).status).toBe(403);
    expect(db.upserts).toHaveLength(1);
  });

  it('spends the ticket on first use', async () => {
    const { ticketUrl } = await startAndBegin();
    expect((await fetch(ticketUrl, { redirect: 'manual' })).status).toBe(403);
  });

  it('expires a ticket and a state after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = await (await fetch(`${base}${MOD}/oauth/start`)).json();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const begin = new URL(start.authorize_url);
    expect((await fetch(`${base}${begin.pathname}${begin.search}`, { redirect: 'manual' })).status).toBe(403);

    vi.useRealTimers();
    const { state, cookie } = await startAndBegin();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await callback(state, cookie)).status).toBe(403);
    expect(db.upserts).toHaveLength(0);
  });

  it('will not start with a secret it cannot decrypt, rather than sending ciphertext to Google', async () => {
    process.env.GATEWAZE_SECRETS_KEY = OTHER_KEY;
    db.config.clientSecret = sealSecret('GOCSPX-abcdefghijkl');
    process.env.GATEWAZE_SECRETS_KEY = KEY;
    expect((await fetch(`${base}${MOD}/oauth/start`)).status).toBe(503);
  });

  it('will not start with a malformed client ID', async () => {
    db.config.clientId = 'not-a-client-id';
    expect((await fetch(`${base}${MOD}/oauth/start`)).status).toBe(503);
  });

  it('shows what Google reported, escaped', async () => {
    const r = await fetch(`${base}${PUB}/oauth/callback?error=<script>alert(1)</script>`);
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain('<script>alert(1)');
    expect(text).toContain('&lt;script&gt;');
  });
});
