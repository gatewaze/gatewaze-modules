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

let revokeResult = true;
const enqueued: Array<{ queue: string; name: string; data: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
const fakeEnqueue = async (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
  enqueued.push({ queue, name, data, opts });
  return { id: `job-${enqueued.length}` };
};
const db = {
  config: {} as Record<string, unknown>,
  upserts: [] as unknown[],
  /** Force the next installed_modules read or the connections read to fail. */
  failRead: false,
  failConnections: false,
  /** The connection row the disconnect route reads, and what it last wrote. */
  connection: null as Record<string, unknown> | null,
  connectionUpdate: null as Record<string, unknown> | null,
  connectionReads: 0,
  failConnRead: false,
  failConnUpdate: false,
};

vi.mock('../lib/service-client.js', () => {
  function chain(table: string) {
    const st: { op: string; payload?: unknown; single?: boolean; eqs: Record<string, unknown>; isNull: string[] } = { op: 'select', eqs: {}, isNull: [] };
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => { st.eqs[col] = val; return b; },
      is: (col: string, val: unknown) => { if (val === null) st.isNull.push(col); return b; },
      order: () => b,
      update: (p: unknown) => { st.op = 'update'; st.payload = p; return b; },
      upsert: (p: unknown) => { db.upserts.push(p); st.op = 'upsert'; return b; },
      maybeSingle: () => { st.single = true; return b; },
      then: (resolve: (v: unknown) => void) => {
        if (table === 'installed_modules' && st.op === 'update') {
          db.config = (st.payload as { config: Record<string, unknown> }).config;
          return resolve({ data: null, error: null });
        }
        if (table === 'installed_modules') {
          if (db.failRead) return resolve({ data: null, error: { message: 'boom' } });
          return resolve({ data: { config: db.config }, error: null });
        }
        // The connection row honours the filters it is given, like Postgres.
        const conn = db.connection;
        const matches = (c: Record<string, unknown> | null) => !!c
          && Object.entries(st.eqs).every(([k, v]) => c[k] === v)
          && st.isNull.every((k) => c[k] == null);
        if (table === 'video_platform_connections' && st.op === 'update') {
          if (db.failConnUpdate) return resolve({ data: null, error: { message: 'boom' } });
          if (!matches(conn)) return resolve({ data: [], error: null });
          db.connectionUpdate = st.payload as Record<string, unknown>;
          return resolve({ data: [{ id: conn!.id }], error: null });
        }
        if (table === 'video_platform_connections' && st.op === 'select' && st.single) {
          db.connectionReads += 1;
          if (db.failConnRead) return resolve({ data: null, error: { message: 'boom' } });
          return resolve({ data: matches(conn) ? conn : null, error: null });
        }
        if (table === 'video_platform_connections' && st.op === 'select' && !db.failConnections && conn) {
          return resolve({ data: [conn], error: null });
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
    revokeToken: vi.fn(async () => revokeResult),
  };
});

const { registerRoutes } = await import('../api/register-routes.js');
const { sealSecret } = await import('../lib/secret-envelope.js');
const { CLIENT_ID_RE } = await import('../lib/settings.js');
const manifest = (await import('../index.js')).default;
const oauthMod = await import('../lib/oauth.js');

let base = '';
let server: ReturnType<express.Express['listen']>;
const CLIENT_ID = '141648865687-57gl4d6ck3uogo66k95jghtsrludlo4c.apps.googleusercontent.com';
const MOD = '/api/modules/videos-publisher-youtube';
const PUB = '/api/videos-publisher-youtube';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRoutes(app as any, { enqueueJob: fakeEnqueue });
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
  db.connection = null;
  db.connectionUpdate = null;
  db.connectionReads = 0;
  db.failConnRead = false;
  db.failConnUpdate = false;
  enqueued.length = 0;
  revokeResult = true;
  vi.mocked(oauthMod.revokeToken).mockClear();
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
    // Reconnecting a disconnected channel restores it on the same row.
    expect(db.upserts[0]).toMatchObject({ platform: 'youtube', state: 'connected', state_detail: null, collection_enabled: true });
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

describe('disconnect', () => {
  const CONN = 'c0000000-0000-0000-0000-000000000001';
  const disconnect = (id: string) => fetch(`${base}${MOD}/connections/${id}/disconnect`, { method: 'POST' });
  const row = (extra: Record<string, unknown> = {}) => ({
    id: CONN, platform: 'youtube', label: 'Dan Baker', external_account_id: 'UCxxxxxxxxxxxxxxxxxxxxxx',
    state: 'connected', encrypted_credentials: sealSecret('refresh-token-value'), updated_at: '2026-11-11T09:00:00.000Z', ...extra,
  });

  it('revokes at Google, drops the token, stops collection, and keeps the row', async () => {
    db.connection = row();
    const r = await disconnect(CONN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, revoked: true });
    expect(oauthMod.revokeToken).toHaveBeenCalledWith('refresh-token-value');
    expect(db.connectionUpdate).toMatchObject({
      state: 'disconnected', encrypted_credentials: null, collection_enabled: false,
      state_detail: 'Disconnected by an admin; access revoked at Google.',
    });
    db.connection = { ...db.connection, ...db.connectionUpdate };
    const list = await (await fetch(`${base}${MOD}/connections`)).json();
    expect(list.connections[0]).toMatchObject({ state: 'disconnected', needs_manual_revoke: false });
  });

  it('still disconnects when Google does not confirm, and keeps it listed for a manual revoke', async () => {
    revokeResult = false;
    db.connection = row();
    expect(await (await disconnect(CONN)).json()).toEqual({ ok: true, revoked: false });
    expect(db.connectionUpdate).toMatchObject({ state: 'disconnected', encrypted_credentials: null });
    db.connection = { ...db.connection, ...db.connectionUpdate };
    const list = await (await fetch(`${base}${MOD}/connections`)).json();
    expect(list.connections[0]).toMatchObject({ state: 'disconnected', needs_manual_revoke: true });
    expect(JSON.stringify(list)).not.toContain('v1:');
  });

  it('does not call Google for a credential it cannot unseal, and still disconnects', async () => {
    process.env.GATEWAZE_SECRETS_KEY = OTHER_KEY;
    db.connection = row({ encrypted_credentials: sealSecret('t') });
    process.env.GATEWAZE_SECRETS_KEY = KEY;
    expect(await (await disconnect(CONN)).json()).toEqual({ ok: true, revoked: false });
    expect(oauthMod.revokeToken).not.toHaveBeenCalled();
    expect(db.connectionUpdate).toMatchObject({ state: 'disconnected' });
  });

  it('leaves an already-disconnected row as it is', async () => {
    db.connection = row({ state: 'disconnected', encrypted_credentials: null, state_detail: 'Disconnected by an admin; access revoked at Google.' });
    expect(await (await disconnect(CONN)).json()).toEqual({ ok: true, revoked: null });
    expect(db.connectionUpdate).toBeNull();
    expect(oauthMod.revokeToken).not.toHaveBeenCalled();
  });

  it('never touches a connection of another platform', async () => {
    db.connection = row({ platform: 'spotify' });
    expect((await disconnect(CONN)).status).toBe(404);
    expect(db.connectionUpdate).toBeNull();
  });

  it('refuses a malformed id before reading anything, and 404s an unknown one', async () => {
    expect((await disconnect('not-a-uuid')).status).toBe(404);
    expect(db.connectionReads).toBe(0);
    expect((await disconnect(CONN)).status).toBe(404);
    expect(db.connectionUpdate).toBeNull();
  });

  it('does not undo a reconnect that landed in between', async () => {
    db.connection = row();
    // Simulate the callback storing a new credential after the read.
    vi.mocked(oauthMod.revokeToken).mockImplementationOnce(async () => {
      db.connection = { ...db.connection!, encrypted_credentials: sealSecret('new-token'), updated_at: '2026-11-11T09:00:05.000Z' };
      return true;
    });
    expect((await disconnect(CONN)).status).toBe(409);
    expect(db.connectionUpdate).toBeNull();
  });

  it('answers database failures with a 500', async () => {
    db.connection = row();
    db.failConnRead = true;
    expect((await disconnect(CONN)).status).toBe(500);
    db.failConnRead = false;
    db.failConnUpdate = true;
    const r = await disconnect(CONN);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('boom');
  });

  it('is not served on the public prefix', async () => {
    expect((await fetch(`${base}${PUB}/connections/${CONN}/disconnect`, { method: 'POST' })).status).toBe(404);
  });
});

describe('sync now', () => {
  const CONN = 'c0000000-0000-0000-0000-000000000002';
  const sync = (id: string) => fetch(`${base}${MOD}/connections/${id}/sync`, { method: 'POST' });

  it('queues a full discovery run for that one channel, de-duplicated by a time bucket', async () => {
    db.connection = { id: CONN, platform: 'youtube', state: 'connected' };
    const r = await sync(CONN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ queued: true, job_id: 'job-1' });
    expect(enqueued[0]).toMatchObject({
      queue: 'jobs',
      name: 'videos-publisher-youtube:discover-videos',
      data: { connection_id: CONN, cap: 5000 },
    });
    expect(String(enqueued[0].opts?.jobId)).toMatch(new RegExp(`^videos-publisher-youtube-sync-${CONN}-\\d+$`));
  });

  it('refuses a channel that is not connected', async () => {
    db.connection = { id: CONN, platform: 'youtube', state: 'disconnected' };
    expect((await sync(CONN)).status).toBe(409);
    expect(enqueued).toHaveLength(0);
  });

  it('refuses another platform, a malformed id, and an unknown id', async () => {
    db.connection = { id: CONN, platform: 'spotify', state: 'connected' };
    expect((await sync(CONN)).status).toBe(404);
    expect((await sync('nope')).status).toBe(404);
    db.connection = null;
    expect((await sync(CONN)).status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('is not served on the public prefix', async () => {
    expect((await fetch(`${base}${PUB}/connections/${CONN}/sync`, { method: 'POST' })).status).toBe(404);
  });

  it('answers 503 when the server has no job queue', async () => {
    const bare = express();
    bare.use(express.json());
    registerRoutes(bare as any);
    const srv = bare.listen(0);
    try {
      db.connection = { id: CONN, platform: 'youtube', state: 'connected' };
      const port = (srv.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}${MOD}/connections/${CONN}/sync`, { method: 'POST' })).status).toBe(503);
    } finally {
      srv.close();
    }
  });
});

