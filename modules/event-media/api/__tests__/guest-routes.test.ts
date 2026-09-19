// @ts-nocheck — vitest harness; route handlers are @ts-nocheck'd already.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGuestRoutes } from '../public-guest-routes.js';
import { mintTicket, TICKET_TTL_SECONDS } from '../../lib/upload-tickets.js';

const SECRET = 'guest-routes-test-secret';
const EVENT_ID = '99999999-8888-7777-6666-555555555555';
const LINK_ID = '44444444-3333-2222-1111-000000000000';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CODE = 'abcdef1234';

const ACTIVE_LINK = {
  id: LINK_ID,
  event_id: EVENT_ID,
  short_code: CODE,
  label: 'Wedding day QR',
  is_active: true,
  expires_at: null,
  require_name: true,
  allow_video: true,
  auto_approve: true,
  show_gallery: true,
  max_photo_bytes: 50 * 1024 * 1024,
  max_video_bytes: 2 * 1024 * 1024 * 1024,
  logo_url: null,
};

const EVENT_ROW = { id: EVENT_ID, event_id: '9ej2d3', event_slug: 'dan-sarah', event_title: 'Dan & Sarah' };

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(s) { res.statusCode = s; return res; },
    json(b) { res.body = b; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
  };
  return res;
}

/** Chainable, thenable per-table query builder. Terminal behaviour:
 *  await builder → { data: listData }, .maybeSingle() → singleData. */
function makeSupabase(config) {
  const state = {
    inserted: [],
    removed: [],
    rpcCalls: [],
    invoked: [],
    signedUploadErr: config.signedUploadErr ?? null,
  };

  function builder(table) {
    const b = {
      _table: table,
      select: () => b,
      eq: () => b,
      gt: () => b,
      like: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (table === 'events_media_upload_links') return Promise.resolve({ data: config.link ?? null, error: null });
        if (table === 'events') return Promise.resolve({ data: config.event ?? null, error: null });
        if (table === 'host_media') return Promise.resolve({ data: config.existingMedia ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve) => resolve({ data: config.mediaRows ?? [], error: config.mediaListError ?? null }),
      insert: (row) => {
        state.inserted.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve(
              config.insertError
                ? { data: null, error: { message: config.insertError } }
                : { data: { ...row, created_at: '2026-09-19T18:00:00.000Z', width: null, height: null, variants: null }, error: null },
            ),
          }),
        };
      },
    };
    return b;
  }

  return {
    state,
    from: (table) => builder(table),
    rpc: (name, args) => { state.rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }); },
    functions: {
      invoke: (name, opts) => { state.invoked.push({ name, opts }); return Promise.resolve({ data: null, error: null }); },
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: () => Promise.resolve(
          state.signedUploadErr
            ? { data: null, error: { message: state.signedUploadErr } }
            : { data: { signedUrl: 'http://internal-supabase:8000/storage/v1/object/upload/sign/x?token=t' }, error: null },
        ),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://signed.example/head' }, error: null }),
        remove: (paths) => { state.removed.push(...paths); return Promise.resolve({ data: null, error: null }); },
      }),
    },
  };
}

function makeDeps(config = {}) {
  const supabase = makeSupabase(config);
  const rateDenials = new Set(config.denyRateKeys ?? []);
  const rateCalls = [];
  return {
    supabase,
    rateCalls,
    deps: {
      supabase,
      storageBucket: 'media',
      publicSupabaseUrl: 'https://supabase.public.example',
      internalSupabaseUrl: 'http://internal-supabase:8000',
      rateLimit: async (key, max, windowMs) => {
        rateCalls.push({ key, max, windowMs });
        if ([...rateDenials].some((d) => key.includes(d))) return { allowed: false, resetAt: Date.now() + 1000 };
        return { allowed: true, resetAt: Date.now() + 1000 };
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ticketSecret: SECRET,
    },
  };
}

function req(overrides = {}) {
  return { params: { code: CODE }, query: {}, body: {}, ip: '203.0.113.9', headers: {}, ...overrides };
}

function ticketFor(overrides = {}) {
  return mintTicket({
    media_id: '11111111-2222-3333-4444-555555555555',
    code: CODE,
    event_id: EVENT_ID,
    storage_path: `event/${EVENT_ID}/11111111-2222-3333-4444-555555555555/photo.jpg`,
    mime_type: 'image/jpeg',
    max_bytes: ACTIVE_LINK.max_photo_bytes,
    guest_name: 'Auntie Carol',
    client_id: CLIENT_ID,
    captured: false,
    exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
    ...overrides,
  }, SECRET);
}

function stubHead(response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('link resolution', () => {
  it('404s an unknown code', async () => {
    const { deps } = makeDeps({ link: null });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('link_not_found');
  });

  it('404s an inactive link identically', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, is_active: false }, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('link_not_found');
  });

  it('404s an expired link identically', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, expires_at: '2000-01-01T00:00:00Z' }, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s a malformed code without touching the db', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req({ params: { code: 'НЕТ-‼️' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('rate-limits by IP before resolution', async () => {
    const { deps, rateCalls } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, denyRateKeys: ['resolve:ip'] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    expect(rateCalls[0].key).toContain('203.0.113.9');
  });

  it('keeps each op in its own per-IP bucket (list starvation cannot block mint)', async () => {
    // Venue-NAT scenario: the list bucket is exhausted; mint must still work.
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, denyRateKeys: ['list:ip'] });
    const routes = createGuestRoutes(deps);

    const listRes = mockRes();
    await routes.listMedia(req(), listRes);
    expect(listRes.statusCode).toBe(429);

    const mintRes = mockRes();
    await routes.mintUploads(req({
      body: { client_id: CLIENT_ID, guest_name: 'C', files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] },
    }), mintRes);
    expect(mintRes.statusCode).toBe(200);
  });

  it('answers 503 not_configured when the ticket secret is unavailable', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    deps.ticketSecret = null;
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({
      body: { client_id: CLIENT_ID, guest_name: 'C', files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] },
    }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('not_configured');
  });

  it('resolves an active link with settings + no-store', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.event.identifier).toBe('dan-sarah');
    expect(res.body.event.id).toBe(EVENT_ID);
    expect(res.body.settings.require_name).toBe(true);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

describe('listMedia', () => {
  const ROW = {
    id: '11111111-2222-3333-4444-555555555555',
    storage_path: `event/${EVENT_ID}/x/img.jpg`,
    mime_type: 'image/jpeg',
    bytes: 100,
    width: null,
    height: null,
    variants: { thumb: `event/${EVENT_ID}/x/variants/thumb.jpg` },
    metadata: { source: 'guest', guest_name: 'Auntie Carol', client_id: CLIENT_ID },
    created_at: '2026-09-19T18:00:00.000Z',
  };

  it('404s when the link hides the gallery', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, show_gallery: false }, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMedia(req(), res);
    expect(res.statusCode).toBe(404);
  });

  it('maps rows to public URLs and exposes guest_name only for guest rows', async () => {
    const adminRow = { ...ROW, id: '22222222-2222-3333-4444-555555555555', metadata: {} };
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, mediaRows: [ROW, adminRow] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMedia(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].url).toBe(`https://supabase.public.example/storage/v1/object/public/media/${ROW.storage_path}`);
    expect(res.body.items[0].variants.thumb).toContain('/variants/thumb.jpg');
    expect(res.body.items[0].guest_name).toBe('Auntie Carol');
    expect(res.body.items[1].guest_name).toBeNull();
    expect(res.body.items[0].kind).toBe('photo');
  });

  it('emits next_cursor when a full page came back', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...ROW, id: `${i}1111111-2222-3333-4444-555555555555` }));
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, mediaRows: rows });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMedia(req({ query: { limit: '2' } }), res);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.next_cursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(res.body.next_cursor, 'base64url').toString('utf8'));
    expect(decoded.i).toBe(res.body.items[1].id);
  });

  it('ignores malformed cursors and after values', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, mediaRows: [] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMedia(req({ query: { cursor: '!!nonsense!!', after: 'DROP TABLE' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('mintUploads', () => {
  it('rejects a missing/invalid client_id', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({ body: { client_id: 'nope', files: [] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('requires a name when the link says so', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({ body: { client_id: CLIENT_ID, files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('name_required');
  });

  it('does not require a name when the link disables it', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, require_name: false }, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({ body: { client_id: CLIENT_ID, files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items[0].status).toBe('ready');
  });

  it('caps the batch at 20 files', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    const files = Array.from({ length: 21 }, (_, i) => ({ filename: `${i}.jpg`, mime_type: 'image/jpeg', bytes: 10 }));
    await routes.mintUploads(req({ body: { client_id: CLIENT_ID, guest_name: 'C', files } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('mints tickets + externalised upload URLs, 207 on partial failure', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({
      body: {
        client_id: CLIENT_ID,
        guest_name: 'Auntie Carol',
        files: [
          { filename: 'ok.jpg', mime_type: 'image/jpeg', bytes: 10, captured: true },
          { filename: 'nope.exe', mime_type: 'application/x-msdownload', bytes: 10 },
        ],
      },
    }), res);
    expect(res.statusCode).toBe(207);
    const [ok, bad] = res.body.items;
    expect(ok.status).toBe('ready');
    expect(ok.upload_url.startsWith('https://supabase.public.example/')).toBe(true);
    expect(ok.ticket.split('.')).toHaveLength(2);
    expect(ok.storage_path).toContain(`event/${EVENT_ID}/`);
    expect(bad.status).toBe('failed');
    expect(bad.error).toBe('unsupported_media_type');
  });

  it('rejects video files when the link disables video', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, allow_video: false }, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({
      body: { client_id: CLIENT_ID, guest_name: 'C', files: [{ filename: 'v.mp4', mime_type: 'video/mp4', bytes: 10 }] },
    }), res);
    expect(res.statusCode).toBe(207);
    expect(res.body.items[0].error).toBe('video_not_allowed');
  });

  it('rate-limits per client_id', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, denyRateKeys: [`mint:${CLIENT_ID}`] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.mintUploads(req({ body: { client_id: CLIENT_ID, guest_name: 'C', files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] } }), res);
    expect(res.statusCode).toBe(429);
  });
});

describe('completeUploads', () => {
  function headOk(bytes = 1000, contentType = 'image/jpeg') {
    return { ok: true, headers: new Map([['content-length', String(bytes)], ['content-type', contentType]]) };
  }
  // fetch stub returning header map with .get
  function stubHeadResponse(resp) {
    stubHead({ ok: resp.ok, headers: { get: (k) => (resp.headers instanceof Map ? resp.headers.get(k) : null) ?? null } });
  }

  it('creates a row, fires the variants fn, and increments the counter', async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: null });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items[0].status).toBe('created');
    expect(res.body.items[0].item.guest_name).toBe('Auntie Carol');
    expect(supabase.state.inserted).toHaveLength(1);
    const row = supabase.state.inserted[0];
    expect(row.host_kind).toBe('event');
    expect(row.access_level).toBe('public');
    expect(row.is_approved).toBe(true);
    expect(row.uploaded_by).toBeNull();
    expect(row.metadata.upload_link_id).toBe(LINK_ID);
    expect(supabase.state.invoked[0].name).toBe('media-process-image');
    expect(supabase.state.invoked[0].opts.body.table).toBe('host_media');
    expect(supabase.state.rpcCalls[0]).toEqual({ name: 'events_media_upload_links_increment', args: { p_link_id: LINK_ID, p_n: 1 } });
  });

  it('stamps is_approved=false when the link does not auto-approve', async () => {
    const { deps, supabase } = makeDeps({ link: { ...ACTIVE_LINK, auto_approve: false }, event: EVENT_ROW });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(supabase.state.inserted[0].is_approved).toBe(false);
  });

  it('returns already_created for a replayed ticket', async () => {
    const existing = {
      id: '11111111-2222-3333-4444-555555555555',
      storage_path: 'event/x/y/photo.jpg',
      mime_type: 'image/jpeg',
      bytes: 10, width: null, height: null, variants: null,
      metadata: { source: 'guest', guest_name: 'Auntie Carol' },
      created_at: '2026-09-19T18:00:00.000Z',
    };
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: existing });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.body.items[0].status).toBe('already_created');
    expect(supabase.state.inserted).toHaveLength(0);
    expect(supabase.state.rpcCalls).toHaveLength(0);
  });

  it('rejects a tampered ticket and a ticket for another link', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({
      body: { tickets: ['garbage.ticket', ticketFor({ code: 'zzzzzzzzzz' })] },
    }), res);
    expect(res.statusCode).toBe(207);
    expect(res.body.items[0].error).toBe('invalid_ticket');
    expect(res.body.items[1].error).toBe('invalid_ticket');
  });

  it('fails object_missing when the storage HEAD 404s', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    stubHeadResponse({ ok: false, headers: new Map() });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.body.items[0].error).toBe('object_missing');
  });

  it('deletes an oversize object and fails the item', async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    stubHeadResponse(headOk(ACTIVE_LINK.max_photo_bytes * 1.2));
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.body.items[0].error).toBe('file_too_large');
    expect(supabase.state.removed).toHaveLength(1);
    expect(supabase.state.inserted).toHaveLength(0);
  });

  it('deletes and fails on a Content-Type mismatch', async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    stubHeadResponse(headOk(1000, 'application/x-msdownload'));
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.body.items[0].error).toBe('mime_mismatch');
    expect(supabase.state.removed).toHaveLength(1);
  });

  it('fails closed when storage reports no Content-Type at all', async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    stubHeadResponse({ ok: true, headers: new Map([['content-length', '1000']]) });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.body.items[0].error).toBe('mime_mismatch');
    expect(supabase.state.inserted).toHaveLength(0);
  });

  it('rejects tickets when the link was deactivated after mint', async () => {
    const { deps } = makeDeps({ link: { ...ACTIVE_LINK, is_active: false }, event: EVENT_ROW });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('enforces the per-link hourly circuit breaker', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, denyRateKeys: ['complete_link'] });
    stubHeadResponse(headOk());
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.completeUploads(req({ body: { tickets: [ticketFor()] } }), res);
    expect(res.statusCode).toBe(429);
  });
});
