import { afterEach, describe, expect, it, vi } from 'vitest';

// googleSheetsOAuth imports the core supabase client; only getSession is
// used, so that is all the stub provides.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'session-token' } } }) },
  },
}));

import { startGoogleSheetsOAuth } from '../googleSheetsOAuth';

const SUPABASE_URL = 'https://project.supabase.co';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('startGoogleSheetsOAuth', () => {
  it('asks the server for the consent URL with the session bearer and returns it', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await startGoogleSheetsOAuth('abc123', 'registration', '/events/abc123?tab=x');

    expect(result).toEqual({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/integrations-google-sheets-oauth/authorize`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect(JSON.parse(String(init.body))).toEqual({
      eventId: 'abc123',
      notificationType: 'registration',
      returnUrl: '/events/abc123?tab=x',
    });
  });

  it.each([
    'https://evil.example/o/oauth2/v2/auth',
    'https://accounts.google.com.evil.example/',
    'javascript:alert(1)',
  ])('refuses to hand back a URL that is not Google consent: %s', async (bad) => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorize_url: bad }), { status: 200 })));
    const result = await startGoogleSheetsOAuth('abc123', 'registration', '/');
    expect(result.url).toBeUndefined();
    expect(result.error).toMatch(/Unexpected/);
  });

  it('returns the server error and no URL when the server refuses', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })));
    expect(await startGoogleSheetsOAuth('abc123', 'registration', '/')).toEqual({ error: 'Forbidden' });
  });

  it('returns an error, not a URL, when the network call fails', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const result = await startGoogleSheetsOAuth('abc123', 'registration', '/');
    expect(result.url).toBeUndefined();
    expect(result.error).toMatch(/Network error/);
  });
});
