import { describe, expect, it } from 'vitest';
import { CVENT_BASE, createCventClient, filterLiteral } from '../cvent-api';

interface Call {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

/** Scripted fetch: each matcher answers the first call whose path matches it. */
function fakeFetch(routes: Array<{ match: RegExp; status: number; body: unknown; once?: boolean }>) {
  const calls: Call[] = [];
  const used = new Set<number>();
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // JSON bodies are parsed for assertions; the token request is form-encoded and kept raw.
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body, headers });
    const idx = routes.findIndex((r, i) => r.match.test(url) && !(r.once && used.has(i)));
    if (idx < 0) throw new Error(`unexpected call ${init?.method ?? 'GET'} ${url}`);
    used.add(idx);
    const r = routes[idx];
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const token = { match: /oauth2\/token$/, status: 200, body: { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' } };
const noSleep = async () => {};

describe('filterLiteral', () => {
  it('doubles single quotes so an email cannot end the literal early', () => {
    expect(filterLiteral("o'brien@x.com")).toBe("'o''brien@x.com'");
    expect(filterLiteral('plain@x.com')).toBe("'plain@x.com'");
  });
});

describe('createCventClient', () => {
  it('fetches one token and reuses it across calls', async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/admission-items\?/, status: 200, body: { data: [{ id: 'a1', name: 'General', code: 'GEN' }] } },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });

    const first = await c.listAdmissionItems('evt-1');
    const second = await c.listAdmissionItems('evt-1');

    expect(first).toEqual({ success: true, items: [{ id: 'a1', name: 'General', code: 'GEN' }] });
    expect(second.success).toBe(true);
    expect(calls.filter((x) => x.url.endsWith('/oauth2/token'))).toHaveLength(1);
    const api = calls.filter((x) => x.url.includes('/admission-items'));
    expect(api).toHaveLength(2);
    expect(api[0].headers.Authorization).toBe('Bearer tok');
    expect(api[0].url).toBe(`${CVENT_BASE}/admission-items?filter=${encodeURIComponent("event.id eq 'evt-1'")}`);
  });

  it('sends the client credentials as basic auth when fetching the token', async () => {
    const { fetchImpl, calls } = fakeFetch([token, { match: /\/admission-items\?/, status: 200, body: { data: [] } }]);
    const c = createCventClient({ clientId: 'my-id', clientSecret: 's3cret', fetch: fetchImpl, sleep: noSleep });
    await c.listAdmissionItems('evt-1');
    const t = calls[0];
    expect(t.headers.Authorization).toBe(`Basic ${Buffer.from('my-id:s3cret').toString('base64')}`);
    expect(t.headers.Authorization).not.toContain('s3cret');
  });

  it('reports an OAuth failure as a result, not a throw', async () => {
    const { fetchImpl } = fakeFetch([{ match: /oauth2\/token$/, status: 401, body: { error: 'invalid_client' } }]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'bad', fetch: fetchImpl, sleep: noSleep });
    const r = await c.syncRegistrant('evt', 'adm', { email: 'a@b.com' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Cvent OAuth failed \(401\)/);
  });

  it('creates a contact and registers an attendee for a new email', async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/contacts\?filter=/, status: 200, body: { data: [] } },
      { match: /\/contacts$/, status: 207, body: [{ status: 201, data: { id: 'c-new' } }] },
      { match: /\/attendees$/, status: 207, body: [{ status: 201, data: { id: 'att-1' } }] },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });

    const r = await c.syncRegistrant('evt-1', 'adm-1', { email: 'new@x.com', firstName: 'Ada', title: 'Engineer' });

    expect(r).toEqual({ success: true, contactId: 'c-new', attendeeId: 'att-1', action: 'created' });
    const create = calls.find((x) => x.url.endsWith('/contacts') && x.method === 'POST')!;
    // Bulk endpoint takes an array; lastName falls back to the first name.
    expect(create.body).toEqual([{ email: 'new@x.com', firstName: 'Ada', lastName: 'Ada', title: 'Engineer' }]);
    const attendee = calls.find((x) => x.url.endsWith('/attendees'))!;
    expect(attendee.body).toEqual([
      { event: { id: 'evt-1' }, contact: { id: 'c-new' }, admissionItem: { id: 'adm-1' }, status: 'Accepted' },
    ]);
  });

  it('reuses an existing contact, updates changed fields, and treats an existing attendee as success', async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/contacts\?filter=/, status: 200, body: { data: [{ id: 'c-1', firstName: 'Ada', lastName: 'Lovelace', company: 'Old Co' }] } },
      { match: /\/contacts\/c-1$/, status: 200, body: { id: 'c-1' } },
      { match: /\/attendees$/, status: 207, body: [{ status: 400, data: { code: 'EntityAlreadyExists' } }] },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });

    const r = await c.syncRegistrant('evt-1', 'adm-1', { email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace', company: 'New Co' });

    expect(r).toEqual({ success: true, contactId: 'c-1', action: 'already_exists' });
    const put = calls.find((x) => x.method === 'PUT')!;
    expect(put.body).toEqual({ id: 'c-1', email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace', company: 'New Co' });
    expect(calls.some((x) => x.url.endsWith('/contacts') && x.method === 'POST')).toBe(false);
  });

  it('does not update an existing contact whose fields already match', async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/contacts\?filter=/, status: 200, body: { data: [{ id: 'c-1', firstName: 'Ada', lastName: 'Lovelace' }] } },
      { match: /\/attendees$/, status: 207, body: [{ status: 200, data: { id: 'att-9' } }] },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });
    const r = await c.syncRegistrant('evt-1', 'adm-1', { email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace' });
    expect(r.action).toBe('created');
    expect(calls.some((x) => x.method === 'PUT')).toBe(false);
  });

  it('returns the attendee error when registration fails for another reason', async () => {
    const { fetchImpl } = fakeFetch([
      token,
      { match: /\/contacts\?filter=/, status: 200, body: { data: [{ id: 'c-1' }] } },
      { match: /\/attendees$/, status: 207, body: [{ status: 400, data: { code: 'InvalidAdmissionItem', message: 'nope' } }] },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });
    const r = await c.syncRegistrant('evt-1', 'adm-bad', { email: 'ada@x.com' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/POST \/attendees failed \(400\)/);
    expect(r.error).toContain('InvalidAdmissionItem');
  });

  it('retries on 429 with a pause, then succeeds', async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/admission-items\?/, status: 429, body: { message: 'slow down' }, once: true },
      { match: /\/admission-items\?/, status: 200, body: { data: [] } },
    ]);
    const c = createCventClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const r = await c.listAdmissionItems('evt-1');
    expect(r).toEqual({ success: true, items: [] });
    expect(waits).toEqual([2000]);
    expect(calls.filter((x) => x.url.includes('/admission-items'))).toHaveLength(2);
  });

  it('gives up after the retry limit on persistent 429', async () => {
    const { fetchImpl, calls } = fakeFetch([token, { match: /\/admission-items\?/, status: 429, body: { message: 'slow down' } }]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep, retries: 2 });
    const r = await c.listAdmissionItems('evt-1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/\(429\)/);
    expect(calls.filter((x) => x.url.includes('/admission-items'))).toHaveLength(3);
  });

  it('explains a 413 as the gateway header limit', async () => {
    const { fetchImpl } = fakeFetch([token, { match: /\/admission-items\?/, status: 413, body: '' }]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });
    const r = await c.listAdmissionItems('evt-1');
    expect(r.success).toBe(false);
    expect(r.error).toContain('header size limit');
  });

  it('updateContact pushes new badge fields to an existing contact', async () => {
    const { fetchImpl, calls } = fakeFetch([
      token,
      { match: /\/contacts\?filter=/, status: 200, body: { data: [{ id: 'c-1', firstName: 'Ada', lastName: 'L' }] } },
      { match: /\/contacts\/c-1$/, status: 200, body: { id: 'c-1' } },
    ]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });
    const r = await c.updateContact({ email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace', title: 'CTO' });
    expect(r).toEqual({ success: true, contactId: 'c-1', action: 'updated' });
    expect(calls.find((x) => x.method === 'PUT')!.body).toEqual({ id: 'c-1', email: 'ada@x.com', firstName: 'Ada', lastName: 'Lovelace', title: 'CTO' });
  });

  it('updateContact fails cleanly when the contact is missing', async () => {
    const { fetchImpl } = fakeFetch([token, { match: /\/contacts\?filter=/, status: 200, body: { data: [] } }]);
    const c = createCventClient({ clientId: 'id', clientSecret: 'secret', fetch: fetchImpl, sleep: noSleep });
    const r = await c.updateContact({ email: 'ghost@x.com' });
    expect(r).toEqual({ success: false, error: 'Contact not found in Cvent for ghost@x.com' });
  });
});
