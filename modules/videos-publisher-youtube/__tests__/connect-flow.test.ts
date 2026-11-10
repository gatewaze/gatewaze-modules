/**
 * The connect flow end to end over HTTP: start → begin → callback, and the
 * settings save. A real Express server; the database and Google are fakes.
 *
 * The point is the binding. A Google consent URL is only finishable in the
 * browser that /oauth/begin set its cookie on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

const KEY = Buffer.alloc(32, 3).toString('base64');
process.env.GATEWAZE_SECRETS_KEY = KEY;
process.env.API_URL = 'https://api.example.test';

const db = {
  config: {} as Record<string, unknown>,
  upserts: [] as unknown[],
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
        if (table === 'installed_modules') return resolve({ data: { config: db.config }, error: null });
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

let base = '';
let server: ReturnType<express.Express['listen']>;
const CLIENT_ID = '141648865687-57gl4d6ck3uogo66k95jghtsrludlo4c.apps.googleusercontent.com';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRoutes(app as any);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const put = (body: unknown) =>
  fetch(`${base}/api/modules/videos-publisher-youtube/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('settings', () => {
  it('seals the secret, stores only known fields, and never returns the secret', async () => {
    const r = await put({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-abcdefghijkl', isAdmin: true });
    expect(r.status).toBe(200);
    expect(String(db.config.clientSecret)).toMatch(/^v1:/);
    expect(db.config).not.toHaveProperty('isAdmin');

    const got = await (await fetch(`${base}/api/modules/videos-publisher-youtube/settings`)).json();
    expect(got).toMatchObject({ clientId: CLIENT_ID, clientSecretSet: true, clientSecretReadable: true });
    expect(JSON.stringify(got)).not.toContain('GOCSPX');
    expect(JSON.stringify(got)).not.toContain('v1:');
    expect(got.redirectUri).toBe('https://api.example.test/api/videos-publisher-youtube/oauth/callback');
  });

  it('refuses a new client ID without its secret', async () => {
    const r = await put({ clientId: '999-other.apps.googleusercontent.com' });
    expect(r.status).toBe(400);
  });
});

async function startAndBegin() {
  const start = await (await fetch(`${base}/api/modules/videos-publisher-youtube/oauth/start`)).json();
  const begin = new URL(start.authorize_url);
  expect(begin.pathname).toBe('/api/videos-publisher-youtube/oauth/begin');
  const res = await fetch(`${base}${begin.pathname}${begin.search}`, { redirect: 'manual' });
  return { ticketUrl: `${base}${begin.pathname}${begin.search}`, res };
}

describe('connect flow', () => {
  it('binds the browser and finishes only with the cookie', async () => {
    const { res } = await startAndBegin();
    expect(res.status).toBe(302);
    const google = new URL(res.headers.get('location')!);
    expect(google.host).toBe('accounts.google.com');
    const state = google.searchParams.get('state')!;
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    // Same state, no cookie: someone else's browser.
    const stolen = await fetch(`${base}/api/videos-publisher-youtube/oauth/callback?state=${state}&code=c`);
    expect(stolen.status).toBe(403);
    expect(db.upserts).toHaveLength(0);
  });

  it('connects the channel when the cookie matches', async () => {
    const { res } = await startAndBegin();
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const ok = await fetch(`${base}/api/videos-publisher-youtube/oauth/callback?state=${state}&code=c`, {
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('AAIF Live is connected.');
    expect(db.upserts).toHaveLength(1);
    expect(JSON.stringify(db.upserts[0])).not.toContain('"rt"');
  });

  it('spends the ticket on first use', async () => {
    const { ticketUrl } = await startAndBegin();
    const again = await fetch(ticketUrl, { redirect: 'manual' });
    expect(again.status).toBe(403);
  });

  it('escapes what Google reports', async () => {
    const r = await fetch(`${base}/api/videos-publisher-youtube/oauth/callback?error=<script>alert(1)</script>`);
    expect(await r.text()).not.toContain('<script>alert(1)');
  });
});
