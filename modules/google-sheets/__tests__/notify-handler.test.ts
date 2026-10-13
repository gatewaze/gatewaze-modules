/**
 * Handler tests for the integrations-google-sheets-notify edge function,
 * run the same way as oauth-handler.test.ts: Deno is a stub global that
 * captures the handler, and the jsr: imports are mocked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Test-only values, not real credentials.
const SERVICE_KEY = 'test-service-role-key';
const BASE_ENV: Record<string, string> = {
  GOOGLE_SHEETS_CLIENT_ID: 'test-client-id',
  GOOGLE_SHEETS_CLIENT_SECRET: 'test-client-secret',
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_ANON_KEY: 'test-anon',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SITE_URL: 'https://admin.test',
};
let env: Record<string, string> = { ...BASE_ENV };
let handler: (req: Request) => Promise<Response>;
let defuseCell: (v: string) => string;

let rpcResult: { data: unknown; error: unknown } = { data: true, error: null };
// A connected, enabled config with an access token valid for an hour.
const config = () => ({
  id: 'cfg1',
  event_id: 'e1',
  notification_type: 'registration',
  enabled: true,
  spreadsheet_id: 'sheet123',
  sheet_name: 'Sheet1',
  google_access_token: 'acc-token',
  google_refresh_token: 'ref-token',
  google_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const tablesRead: string[] = [];

// Registrations a historic send reads.
let registrations: Array<Record<string, unknown>> = [];

function query(table: string) {
  const q: Record<string, unknown> = {};
  if (table === 'event_registrations_with_members') {
    q.then = (resolve: (v: unknown) => void) => resolve({ data: registrations, error: null });
  }
  const chain = () => q;
  Object.assign(q, {
    select: chain,
    eq: chain,
    order: chain,
    single: async () => ({ data: null, error: { message: 'not found' } }),
    maybeSingle: async () => ({ data: table === 'event_google_sheets_notifications' ? config() : null, error: null }),
    insert: async () => ({ error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  });
  return q;
}

vi.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}));
vi.mock('jsr:@supabase/supabase-js@2', () => ({
  createClient: () => ({
    auth: {
      getUser: async (jwt: string) =>
        jwt === 'admin-session' || jwt === 'other-session'
          ? { data: { user: { id: jwt } }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
    rpc: async () => rpcResult,
    from: (table: string) => {
      tablesRead.push(table);
      return query(table);
    },
  }),
}));

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => env[k] }, serve: (h: typeof handler) => { handler = h; } });
  ({ defuseCell } = await import('../functions/integrations-google-sheets-notify/index.ts'));
});

let sheetsFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  env = { ...BASE_ENV };
  rpcResult = { data: true, error: null };
  tablesRead.length = 0;
  registrations = [];
  sheetsFetch = vi.fn(async () => new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A2:H2', updatedRows: 1 } })));
  vi.stubGlobal('fetch', sheetsFetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('Deno', { env: { get: (k: string) => env[k] }, serve: () => {} });
  vi.restoreAllMocks();
});

const URL_ = 'https://fn.test/functions/v1/integrations-google-sheets-notify';
const notify = (body: unknown, bearer?: string) =>
  handler(
    new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
const LIVE = { eventId: 'e1', notificationType: 'registration', data: { firstName: 'Ada', email: 'ada@example.test' } };
const TEST = { ...LIVE, isTest: true };
const sentValues = () => JSON.parse(String(((sheetsFetch.mock.calls[0] as unknown[])[1] as RequestInit).body)).values;

describe('who may call notify', () => {
  it('refuses a request without a bearer token (401), before touching the database', async () => {
    expect((await notify(LIVE)).status).toBe(401);
    expect(tablesRead).toEqual([]);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('refuses a request without a bearer token before reading the body', async () => {
    const r = await handler(new Request(URL_, { method: 'POST', body: 'not json' }));
    expect(r.status).toBe(401);
  });

  it('refuses the anon key as a bearer (401)', async () => {
    expect((await notify(LIVE, 'test-anon')).status).toBe(401);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('refuses a test send from a signed-in user who cannot admin the event (403)', async () => {
    rpcResult = { data: false, error: null };
    expect((await notify(TEST, 'other-session')).status).toBe(403);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('refuses a historic send from a non-admin (403)', async () => {
    rpcResult = { data: null, error: null };
    expect((await notify({ eventId: 'e1', notificationType: 'registration', isHistoric: true }, 'other-session')).status).toBe(403);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('lets an event admin run a test send', async () => {
    const r = await notify(TEST, 'admin-session');
    expect(r.status).toBe(200);
    expect(sheetsFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a live push from an event admin (403): only the server pushes live rows', async () => {
    expect((await notify(LIVE, 'admin-session')).status).toBe(403);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('lets the service role push a live registration', async () => {
    const r = await notify(LIVE, SERVICE_KEY);
    expect(r.status).toBe(200);
    expect(sentValues()[0]).toContain('ada@example.test');
  });

  it('refuses a test or historic send made with the service-role key (403)', async () => {
    expect((await notify(TEST, SERVICE_KEY)).status).toBe(403);
    expect((await notify({ ...LIVE, isHistoric: true }, SERVICE_KEY)).status).toBe(403);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it('refuses a near-miss of the service-role key (401)', async () => {
    expect((await notify(LIVE, `${SERVICE_KEY}x`)).status).toBe(401);
    expect((await notify(LIVE, SERVICE_KEY.slice(0, -1))).status).toBe(401);
  });

  it('refuses everything when the service-role key is not configured', async () => {
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await notify(LIVE, 'anything')).status).toBe(401);
    expect(sheetsFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad notification type', { ...LIVE, notificationType: 'payments' }],
    ['a missing eventId', { ...LIVE, eventId: undefined }],
    ['an over-long eventId', { ...LIVE, eventId: 'e'.repeat(65) }],
  ])('refuses %s (400)', async (_l, body) => {
    expect((await notify(body, SERVICE_KEY)).status).toBe(400);
  });

  it('refuses GET (405)', async () => {
    expect((await handler(new Request(URL_, { headers: { Authorization: `Bearer ${SERVICE_KEY}` } }))).status).toBe(405);
  });

  it('allows CORS only for the admin origin', async () => {
    const pre = (origin: string) => handler(new Request(URL_, { method: 'OPTIONS', headers: { Origin: origin } }));
    expect((await pre('https://admin.test')).headers.get('Access-Control-Allow-Origin')).toBe('https://admin.test');
    expect((await pre('https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not let a test send pull another event\'s talk by id', async () => {
    const r = await notify(
      { eventId: 'e1', notificationType: 'speaker_submission', isTest: true, data: { talkId: 'someone-elses-talk' } },
      'admin-session',
    );
    expect(r.status).toBe(200);
    expect(tablesRead).not.toContain('event_talks');
  });
});

describe('formula injection', () => {
  it.each(['=IMPORTXML("https://evil.example","//a")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
    'defuses %j',
    (v) => {
      expect(defuseCell(v)).toBe(`'${v}`);
    },
  );

  it.each(['-1+2', '-A1', '-5x', '-.5+1'])('defuses %j, which only starts like a number', (v) => {
    expect(defuseCell(v)).toBe(`'${v}`);
  });

  it.each(['Ada', 'ada@example.test', '2026-10-13T08:00:00.000Z', '25', '', '-5', '-12.50', '0'])('leaves %j alone', (v) => {
    expect(defuseCell(v)).toBe(v);
  });

  it('defuses formula cells in a historic batch before they reach Google', async () => {
    registrations = [
      { id: 'r1', first_name: '=HYPERLINK("http://x","y")', last_name: 'Lovelace', email: 'ada@example.test', registered_at: '2026-10-01T00:00:00Z', amount_paid: -5 },
    ];
    const r = await notify({ eventId: 'e1', notificationType: 'registration', isHistoric: true }, 'admin-session');
    expect(r.status).toBe(200);
    const row = sentValues()[0];
    expect(row[1]).toBe('\'=HYPERLINK("http://x","y")');
    expect(row[5]).toBe('-5');
  });

  it('defuses formula cells in a pushed row before they reach Google', async () => {
    await notify({ ...LIVE, data: { firstName: '=HYPERLINK("https://evil.example","x")', email: 'a@example.test' } }, SERVICE_KEY);
    const row = sentValues()[0];
    expect(row[1]).toBe('\'=HYPERLINK("https://evil.example","x")');
    expect(row[3]).toBe('a@example.test');
  });
});
