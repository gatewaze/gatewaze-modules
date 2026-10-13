/**
 * Handler tests for the integrations-google-sheets-oauth edge function.
 *
 * The function is Deno code: it calls Deno.serve and Deno.env, and imports
 * supabase-js from jsr:. Here Deno is a stub global that captures the
 * handler, and the jsr: imports are mocked, so index.ts runs under vitest.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { signState, verifyState } from '../functions/integrations-google-sheets-oauth/oauth-state.ts';

// Test-only values, not real credentials.
const SECRET = 'test-signing-secret';
const BASE_ENV: Record<string, string> = {
  GOOGLE_SHEETS_CLIENT_ID: 'test-client-id',
  GOOGLE_SHEETS_CLIENT_SECRET: SECRET,
  SUPABASE_URL: 'https://sb.test',
  PUBLIC_SUPABASE_URL: 'https://db.example.test',
  SUPABASE_ANON_KEY: 'test-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  SITE_URL: 'https://admin.test',
};
let env: Record<string, string> = { ...BASE_ENV };
let handler: (req: Request) => Promise<Response>;

// What the mocked supabase client answers.
let rpcResult: { data: unknown; error: unknown } = { data: true, error: null };
let upsertResult: { error: unknown } = { error: null };
// The row the callback reads back when Google sends no refresh token.
let storedRow: { google_user_email: string | null; google_connected: boolean } | null = null;
const upsert = vi.fn();
const update = vi.fn();

vi.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}));
vi.mock('jsr:@supabase/supabase-js@2', () => ({
  createClient: () => ({
    auth: {
      getUser: async (jwt: string) =>
        jwt === 'good-session'
          ? { data: { user: { id: 'u1' } }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
    rpc: async () => rpcResult,
    from: () => ({
      upsert: async (...a: unknown[]) => {
        upsert(...a);
        return upsertResult;
      },
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: storedRow, error: null }) }) }),
      }),
      update: (...a: unknown[]) => {
        update(...a);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  }),
}));

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  await import('../functions/integrations-google-sheets-oauth/index.ts');
});

beforeEach(() => {
  env = { ...BASE_ENV };
  rpcResult = { data: true, error: null };
  upsertResult = { error: null };
  storedRow = null;
  upsert.mockClear();
  update.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('Deno', { env: { get: (k: string) => env[k] }, serve: () => {} });
  vi.restoreAllMocks();
});

const FN = 'https://fn.test/functions/v1/integrations-google-sheets-oauth';
const post = (path: string, body: unknown, bearer?: string, origin?: string) =>
  handler(
    new Request(`${FN}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const callback = (query: string) => handler(new Request(`${FN}/callback?${query}`));
const location = (r: Response) => new URL(r.headers.get('Location') ?? 'about:blank');
const AUTH_BODY = { eventId: 'e1', notificationType: 'registration', returnUrl: '/events/e1?tab=sheets' };

describe('authorize', () => {
  it('refuses a request without a bearer token (401)', async () => {
    expect((await post('authorize', AUTH_BODY)).status).toBe(401);
  });

  it('refuses an invalid session (401)', async () => {
    expect((await post('authorize', AUTH_BODY, 'expired-session')).status).toBe(401);
  });

  it('refuses a signed-in user who cannot admin the event (403)', async () => {
    rpcResult = { data: false, error: null };
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(403);
  });

  it('refuses an unknown event, where the check returns null without an error (403)', async () => {
    rpcResult = { data: null, error: null };
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(403);
  });

  it.each([
    ['missing', { ...AUTH_BODY, eventId: undefined }],
    ['empty', { ...AUTH_BODY, eventId: '' }],
    ['over 64 characters', { ...AUTH_BODY, eventId: 'e'.repeat(65) }],
    ['not a string', { ...AUTH_BODY, eventId: 42 }],
  ])('refuses an eventId that is %s (400)', async (_l, body) => {
    expect((await post('authorize', body, 'good-session')).status).toBe(400);
  });

  it('fails closed with 503 when only the client id is missing', async () => {
    delete env.GOOGLE_SHEETS_CLIENT_ID;
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(503);
  });

  it('fails closed with 503 when the anon key is missing', async () => {
    delete env.SUPABASE_ANON_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(503);
  });

  it('refuses when the permission check itself errors (403)', async () => {
    rpcResult = { data: null, error: { message: 'boom' } };
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(403);
  });

  it('fails closed with 503 when the client secret is missing', async () => {
    delete env.GOOGLE_SHEETS_CLIENT_SECRET;
    expect((await post('authorize', AUTH_BODY, 'good-session')).status).toBe(503);
  });

  it('refuses GET (405): a navigation cannot carry the bearer token', async () => {
    const r = await handler(new Request(`${FN}/authorize?event_id=e1&notification_type=registration`));
    expect(r.status).toBe(405);
  });

  it('refuses an unknown notification type (400)', async () => {
    expect((await post('authorize', { ...AUTH_BODY, notificationType: 'payments' }, 'good-session')).status).toBe(400);
  });

  it('returns a Google URL with the deployed callback slug and a state bound to the caller', async () => {
    const r = await post('authorize', AUTH_BODY, 'good-session');
    expect(r.status).toBe(200);
    const url = new URL((await r.json()).authorize_url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://db.example.test/functions/v1/integrations-google-sheets-oauth/callback',
    );
    const state = await verifyState(url.searchParams.get('state'), SECRET);
    expect(state).toMatchObject({ e: 'e1', t: 'registration', u: 'u1', r: '/events/e1?tab=sheets' });
  });

  it.each(['https://evil.example/', '//evil.example', '/..//evil.example'])(
    'sanitises returnUrl %s to / before signing',
    async (returnUrl) => {
      const r = await post('authorize', { ...AUTH_BODY, returnUrl }, 'good-session');
      const url = new URL((await r.json()).authorize_url);
      expect((await verifyState(url.searchParams.get('state'), SECRET))?.r).toBe('/');
    },
  );

  it('allows CORS only for the admin origin', async () => {
    const ok = await post('authorize', AUTH_BODY, 'good-session', 'https://admin.test');
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.test');
    const evil = await post('authorize', AUTH_BODY, 'good-session', 'https://evil.example');
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('callback', () => {
  const tokenFetch = (impl?: (u?: string) => Promise<Response>) => {
    const f = vi.fn(
      impl ??
        (async (u: string) =>
          String(u).includes('oauth2.googleapis.com/token')
            ? new Response(JSON.stringify({ access_token: 'acc-token', refresh_token: 'ref-token', expires_in: 3600 }))
            : new Response(JSON.stringify({ email: 'someone@example.test' }))),
    );
    vi.stubGlobal('fetch', f);
    return f;
  };
  const expectErrorRedirect = (r: Response) => {
    expect(r.status).toBe(302);
    expect(location(r).origin).toBe('https://admin.test');
    expect(location(r).searchParams.has('google_sheets_error')).toBe(true);
  };

  it.each([
    ['garbage', async () => 'not-a-state'],
    ['the old unsigned format', async () => btoa(JSON.stringify({ eventId: 'e1', notificationType: 'registration', returnUrl: '/' }))],
    ['signed with another secret', async () => signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, 'other-secret')],
    ['expired', async () => signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET, Date.now() - 11 * 60 * 1000)],
  ])('refuses a state that is %s, logs why, and never exchanges the code', async (_l, make) => {
    const f = tokenFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await callback(`code=c&state=${encodeURIComponent(await make())}`);
    expectErrorRedirect(r);
    expect(f).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/refused callback state: (malformed|bad_signature|expired|bad_payload)/);
  });

  it('refuses a payload edited after signing', async () => {
    const f = tokenFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    const [, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ v: 1, e: 'victim', t: 'registration', r: '/', u: 'u1', iat: Date.now(), n: 'x' }))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expectErrorRedirect(await callback(`code=c&state=${forged}.${sig}`));
    expect(f).not.toHaveBeenCalled();
  });

  it('stores the tokens for the signed event and returns to the signed path', async () => {
    tokenFetch();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/events/e1?tab=sheets', u: 'u1' }, SECRET);
    const r = await callback(`code=c&state=${encodeURIComponent(s)}`);
    expect(location(r).href).toBe('https://admin.test/events/e1?tab=sheets&google_sheets_connected=true&notification_type=registration');
    expect(upsert.mock.calls[0][0]).toMatchObject({ event_id: 'e1', notification_type: 'registration', google_refresh_token: 'ref-token' });
  });

  it('exchanges the code with the deployed callback URL', async () => {
    const f = tokenFetch();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await callback(`code=c&state=${encodeURIComponent(await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET))}`);
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = new URLSearchParams(String(init.body));
    expect(body.get('redirect_uri')).toBe('https://db.example.test/functions/v1/integrations-google-sheets-oauth/callback');
  });

  it.each(['https://evil.example/', '/..//evil.example'])(
    're-checks state.r on the way out: a signed %s still lands on the admin',
    async (r) => {
      tokenFetch();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const s = await signState({ e: 'e1', t: 'registration', r, u: 'u1' }, SECRET);
      const res = await callback(`code=c&state=${encodeURIComponent(s)}`);
      expect(location(res).origin).toBe('https://admin.test');
      expect(location(res).pathname).toBe('/');
    },
  );

  it('does not reflect the error parameter, and logs it on one truncated line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await callback(
      `error=${encodeURIComponent('<script>x</script>\ninjected\u2028\u0085\u001b[31m' + 'a'.repeat(500))}`,
    );
    expectErrorRedirect(r);
    expect(r.headers.get('Location')).not.toMatch(/script|injected/);
    const logged = String(err.mock.calls[0]?.[1]);
    // eslint-disable-next-line no-control-regex -- checking for control characters is the point
    expect(logged).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
    expect(logged.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ['no access_token', { refresh_token: 'ref-token' }],
    ['an empty access_token', { access_token: '' }],
    ['a non-string access_token', { access_token: 42 }],
    ['a non-string refresh_token', { access_token: 'acc-token', refresh_token: { x: 1 } }],
  ])('refuses a token response with %s, logs it, and stores nothing', async (_l, body) => {
    tokenFetch(async () => new Response(JSON.stringify(body)));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    expectErrorRedirect(await callback(`code=c&state=${encodeURIComponent(s)}`));
    expect(upsert).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('logs a failed userinfo request with its status, and still connects', async () => {
    tokenFetch(async (u?: string) =>
      String(u).includes('oauth2.googleapis.com/token')
        ? new Response(JSON.stringify({ access_token: 'acc-token', refresh_token: 'ref-token' }))
        : new Response('{}', { status: 401 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    const r = await callback(`code=c&state=${encodeURIComponent(s)}`);
    expect(location(r).searchParams.get('google_sheets_connected')).toBe('true');
    expect(err.mock.calls.some((c) => String(c[0]).includes('userinfo') && c[1] === 401)).toBe(true);
    expect(upsert.mock.calls[0][0]).toMatchObject({ google_user_email: null });
  });

  describe('when Google sends no refresh token', () => {
    const noRefresh = () =>
      tokenFetch(async (u?: string) =>
        String(u).includes('oauth2.googleapis.com/token')
          ? new Response(JSON.stringify({ access_token: 'acc-token' }))
          : new Response(JSON.stringify({ email: 'a@example.test' })),
      );
    const run = async () => {
      const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
      return callback(`code=c&state=${encodeURIComponent(s)}`);
    };

    it('keeps the stored refresh token when it belongs to the same Google account', async () => {
      noRefresh();
      storedRow = { google_user_email: 'a@example.test', google_connected: true };
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const r = await run();
      expect(location(r).searchParams.get('google_sheets_connected')).toBe('true');
      expect(upsert.mock.calls[0][0].google_refresh_token).toBeUndefined();
    });

    it.each([
      ['another account is stored', { google_user_email: 'other@example.test', google_connected: true }],
      ['nothing is stored', null],
      ['the same account is stored without a refresh token', { google_user_email: 'a@example.test', google_connected: false }],
    ])('saves nothing and asks to reconnect when %s', async (_l, row) => {
      noRefresh();
      storedRow = row;
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await run();
      expectErrorRedirect(r);
      expect(location(r).searchParams.get('google_sheets_error')).toMatch(/refresh token/);
      expect(upsert).not.toHaveBeenCalled();
      expect(err.mock.calls.some((c) => String(c[0]).includes('no refresh token'))).toBe(true);
    });
  });

  it('turns a throw during the exchange into the error redirect, not a JSON 500', async () => {
    tokenFetch(async () => {
      throw new TypeError('network down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    expectErrorRedirect(await callback(`code=c&state=${encodeURIComponent(s)}`));
  });

  it('logs only the code and message of a failed upsert, never the row', async () => {
    tokenFetch();
    upsertResult = { error: { code: '23502', message: 'null value', details: 'Failing row contains (ref-token, acc-token)' } };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    expectErrorRedirect(await callback(`code=c&state=${encodeURIComponent(s)}`));
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/ref-token|acc-token/);
  });

  it('redirects with an error, before spending the code, when the service key is missing', async () => {
    const f = tokenFetch();
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await signState({ e: 'e1', t: 'registration', r: '/', u: 'u1' }, SECRET);
    expectErrorRedirect(await callback(`code=c&state=${encodeURIComponent(s)}`));
    expect(f).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  const body = { eventId: 'e1', notificationType: 'registration' };

  it('refuses a request without a bearer token (401) and clears nothing', async () => {
    expect((await post('disconnect', body)).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses GET (405)', async () => {
    expect((await handler(new Request(`${FN}/disconnect`))).status).toBe(405);
  });

  it.each([
    ['missing', { notificationType: 'registration' }],
    ['over 64 characters', { eventId: 'e'.repeat(65), notificationType: 'registration' }],
  ])('refuses an eventId that is %s (400)', async (_l, b) => {
    expect((await post('disconnect', b, 'good-session')).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a non-admin (403) and clears nothing', async () => {
    rpcResult = { data: false, error: null };
    expect((await post('disconnect', body, 'good-session')).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the tokens for an event admin', async () => {
    const r = await post('disconnect', body, 'good-session');
    expect(r.status).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ google_access_token: null, google_refresh_token: null });
  });

  it('returns 503 when the service key is missing', async () => {
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post('disconnect', body, 'good-session')).status).toBe(503);
  });
});
