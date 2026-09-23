// @ts-nocheck — vitest harness; route handlers are @ts-nocheck'd already.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGuestRoutes } from '../public-guest-routes.js';
import * as provider from '../../lib/booth-provider.js';

// The booth's model calls are replaced wholesale, so no test can reach
// fal: the style call is steered per test, and the projector-layer steps
// that run after a post simply report "not configured".
vi.mock('../../lib/booth-provider.js', async (importOriginal) => {
  const real = await importOriginal();
  const off = () => Promise.resolve({ ok: false, error: 'not_configured' });
  return {
    ...real,
    runStyle: vi.fn(off),
    readFingers: vi.fn(async () => null),
    runSwap: vi.fn(off),
    runDepth: vi.fn(off),
    runCutout: vi.fn(off),
    runPlate: vi.fn(off),
    runCardCopy: vi.fn(off),
    plateHasPeople: vi.fn(async () => null),
  };
});
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
    deleted: [],
    rpcCalls: [],
    invoked: [],
    signedUploadErr: config.signedUploadErr ?? null,
  };

  // Name claims, kept for real: member_id -> client_id.
  state.claims = new Map(Object.entries(config.claims ?? {}));
  function builder(table) {
    let claimMember = null;
    const b = {
      _table: table,
      upsert: (row) => {
        if (table === 'events_media_guest_claims') {
          claimMember = row.member_id;
          if (!state.claims.has(row.member_id)) state.claims.set(row.member_id, row.client_id);
        }
        return Promise.resolve({ error: null });
      },
      select: () => b,
      eq: (col, val) => { if (table === 'events_media_guest_claims' && col === 'member_id') claimMember = val; return b; },
      gt: () => b,
      gte: () => b,
      like: () => b,
      in: (col, vals) => { (state.inCalls ??= []).push({ table, col, vals }); return b; },
      or: () => b,
      contains: () => b,
      order: () => b,
      limit: () => b,
      update: (fields) => {
        (state.updated ??= []).push({ table, fields });
        const u = { eq: () => u, then: (resolve) => resolve({ data: null, error: config.updateError ? { message: config.updateError } : null }) };
        return u;
      },
      delete: () => {
        state.deleted.push(table);
        const d = { eq: () => d, then: (resolve) => resolve({ data: null, error: null }) };
        return d;
      },
      maybeSingle: () => {
        if (table === 'events_media_upload_links') return Promise.resolve({ data: config.link ?? null, error: null });
        if (table === 'events') return Promise.resolve({ data: config.event ?? null, error: null });
        if (table === 'host_media') return Promise.resolve({ data: config.existingMedia ?? null, error: null });
        if (table === 'events_media_booth_settings') return Promise.resolve({ data: config.boothSetting ?? null, error: null });
        if (table === 'events_media_guest_claims') return Promise.resolve({ data: state.claims.has(claimMember) ? { client_id: state.claims.get(claimMember) } : null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve) => {
        if (table === 'events_media_guest_claims') return resolve({ data: [...state.claims].map(([member_id, client_id]) => ({ member_id, client_id })), error: null });
        if (config.tables && table in config.tables) return resolve(config.tables[table]);
        if (table !== 'host_media') return resolve({ data: [], error: null });
        return resolve({ data: config.mediaRows ?? [], error: config.mediaListError ?? null });
      },
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
        upload: (path, bytes, opts) => {
          (state.uploads ??= []).push({ path, bytes: bytes.length, contentType: opts?.contentType });
          const fail = config.uploadErrorOn && path.includes(config.uploadErrorOn);
          return Promise.resolve({ data: null, error: fail ? { message: 'storage down' } : null });
        },
        remove: (paths) => { state.removed.push(...paths); return Promise.resolve({ data: null, error: null }); },
        download: (path) => {
          (state.downloads ??= []).push(path);
          if (!config.themeJson) return Promise.resolve({ data: null, error: { message: 'not found' } });
          const text = JSON.stringify(config.themeJson);
          return Promise.resolve({ data: { size: text.length, text: () => Promise.resolve(text) }, error: null });
        },
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

describe('getLink: the illustrated booth', () => {
  const ROOM = {
    image: 'inside.webp', width: 941, height: 1672,
    window: { x: 0.16, y: 0.18, w: 0.67, h: 0.53 },
    coin: { x: 0.3, y: 0.76, w: 0.1, h: 0.11 },
    panel: { x: 0.14, y: 0.73, w: 0.72, h: 0.18 },
  };
  const THEME = {
    version: 2,
    picker: { image: 'eras.webp', width: 941, height: 1672, tiles: [
      { key: '1980s', x: 0.3, y: 0.2, w: 0.3, h: 0.2 }, { key: '1970s', x: 0.6, y: 0.2, w: 0.3, h: 0.2 },
    ] },
    eras: {
      '1980s': { interior: ROOM, samples: { 'uk-decade-1980s': 'sample-uk-decade-1980s.webp' } },
      '1970s': { interior: { ...ROOM, image: 'inside-1970s.webp' } },
    },
  };
  const BOOTH_LINK = { ...ACTIVE_LINK, allow_face_filter: true };

  beforeEach(() => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'test-placeholder';
  });
  afterEach(() => {
    delete process.env.BOOTH_PROVIDER;
    delete process.env.FAL_API_KEY;
  });

  const get = async (config) => {
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, ...config });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.getLink(req(), res);
    return { res, supabase, routes };
  };

  it('offers every era the theme has a booth for, each with its own looks', async () => {
    const { res, supabase } = await get({ themeJson: THEME });
    expect(supabase.state.downloads).toEqual([`event/${EVENT_ID}/booth-theme/theme.json`]);
    const { booth } = res.body;
    expect(booth.eras.map((e) => e.key)).toEqual(['1970s', '1980s']);
    const eighties = booth.eras.find((e) => e.key === '1980s');
    // A board per place, each with its own six looks.
    expect(eighties.looks.uk.length).toBeGreaterThanOrEqual(6);
    expect(eighties.looks.us.length).toBeGreaterThanOrEqual(6);
    expect(eighties.looks.uk.map((l) => l.id)).not.toEqual(eighties.looks.us.map((l) => l.id));
    expect(eighties.looks.uk.find((l) => l.id === 'uk-decade-1980s').sample)
      .toContain(`/event/${EVENT_ID}/booth-theme/sample-uk-decade-1980s.webp`);
    expect(eighties.looks.uk.find((l) => l.id === 'vhs-box').sample).toBeNull();
    expect(eighties.interior.image).toContain(`/event/${EVENT_ID}/booth-theme/inside.webp`);
    expect(booth.picker.tiles.map((t) => t.key)).toEqual(['1980s', '1970s']);
  });

  // An 80s party: the picker is skipped and only the 80s booth offered.
  it('offers just the one era an event is themed on', async () => {
    const { res } = await get({ themeJson: THEME, tables: {}, boothSetting: { era: '1980s' } });
    expect(res.body.booth.eras.map((e) => e.key)).toEqual(['1980s']);
    expect(res.body.booth.picker.tiles.map((t) => t.key)).toEqual(['1980s']);
  });

  it('treats a garbled setting as all eras', async () => {
    const { res } = await get({ themeJson: THEME, boothSetting: { era: 'drop table' } });
    expect(res.body.booth.eras).toHaveLength(2);
  });

  it('serves no booth when the event has no theme', async () => {
    const { res } = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.body.booth).toBeNull();
  });

  // Without the booth there are no looks, and a board of looks that do
  // nothing is worse than no board.
  it('serves no booth when the link does not offer it', async () => {
    const { res, supabase } = await get({ themeJson: THEME, link: ACTIVE_LINK });
    expect(res.body.booth).toBeNull();
    expect(supabase.state.downloads).toBeUndefined();
  });

  it('reads the theme once and then serves it from cache', async () => {
    const { routes, supabase } = await get({ themeJson: THEME });
    await routes.getLink(req(), mockRes());
    await routes.getLink(req(), mockRes());
    expect(supabase.state.downloads).toHaveLength(1);
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

  it('fills missing variants with render-endpoint URLs for photos only', async () => {
    const bare = { ...ROW, id: '33333333-2222-3333-4444-555555555555', variants: null };
    const vid = { ...ROW, id: '44444444-2222-3333-4444-555555555555', variants: null, mime_type: 'video/mp4' };
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, mediaRows: [bare, vid] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMedia(req(), res);
    const [photo, video] = res.body.items;
    expect(photo.variants.thumb).toContain('/storage/v1/render/image/public/media/');
    expect(photo.variants.thumb).toContain('width=350');
    expect(photo.variants.medium).toContain('width=800');
    expect(video.variants.thumb).toBeUndefined();
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

describe('listMedia: projector views', () => {
  const P1 = '11111111-2222-3333-4444-555555555555';
  const P2 = '22222222-2222-3333-4444-555555555555';
  const row = (id, album) => ({
    id, storage_path: `event/${EVENT_ID}/x/${id}.jpg`, mime_type: 'image/jpeg', bytes: 1,
    width: null, height: null, variants: null, metadata: album ? { album } : {},
    created_at: '2026-09-19T18:00:00.000Z',
  });
  const list = async (config) => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, ...config });
    const res = mockRes();
    await createGuestRoutes(deps).listMedia(req(), res);
    return { res, supabase };
  };

  // An organiser moved P1 from Preload to The day in the Media tab.
  it('reports the view album a photo is in, not its original tag', async () => {
    const { res } = await list({
      mediaRows: [row(P1, 'seed'), row(P2, 'day')],
      tables: {
        event_media_view_albums: { data: [{ album_id: 'a-seed', view: 'seed' }, { album_id: 'a-day', view: 'day' }], error: null },
        host_media_album_items: { data: [{ album_id: 'a-day', media_id: P1 }, { album_id: 'a-day', media_id: P2 }], error: null },
      },
    });
    expect(res.body.items.map((i) => i.album)).toEqual(['day', 'day']);
  });

  it('uses the tags when the event has no view albums', async () => {
    const { res } = await list({ mediaRows: [row(P1, 'booth'), row(P2, null)] });
    expect(res.body.items.map((i) => i.album)).toEqual(['booth', 'seed']);
  });

  // The projector must keep running through an album lookup failure.
  it('falls back to the tags if the album lookup fails', async () => {
    const { res } = await list({
      mediaRows: [row(P1, 'booth')],
      tables: { event_media_view_albums: { data: null, error: { message: 'boom' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.items[0].album).toBe('booth');
  });

  it('looks up membership only for the photos on the page', async () => {
    const { supabase } = await list({
      mediaRows: [row(P1, 'seed')],
      tables: {
        event_media_view_albums: { data: [{ album_id: 'a-seed', view: 'seed' }], error: null },
        host_media_album_items: { data: [], error: null },
      },
    });
    const media = supabase.state.inCalls.find((c) => c.col === 'media_id');
    expect(media.vals).toEqual([P1]);
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

describe('mine (a guest managing their own uploads)', () => {
  const OWNED = {
    id: '77777777-2222-3333-4444-555555555555',
    storage_path: `event/${EVENT_ID}/x/mine.jpg`,
    mime_type: 'image/jpeg',
    bytes: 100, width: null, height: null,
    variants: { thumb: `event/${EVENT_ID}/x/variants/thumb.jpg` },
    metadata: { source: 'guest', client_id: CLIENT_ID, guest_name: 'Dan' },
    host_kind: 'event', host_id: EVENT_ID, is_approved: true,
    created_at: '2026-09-20T10:00:00.000Z',
  };

  it('requires a UUID client_id', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMine(req({ body: { client_id: 'nope' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('lists the caller’s own uploads and flags pending ones', async () => {
    const pending = { ...OWNED, id: '88888888-2222-3333-4444-555555555555', is_approved: false };
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, mediaRows: [OWNED, pending] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.listMine(req({ body: { client_id: CLIENT_ID } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].pending).toBe(false);
    expect(res.body.items[1].pending).toBe(true);
    // The credential is never echoed back to the page.
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_ID);
  });

  it('deletes a row the caller owns, and its stored variants', async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: OWNED });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.deleted).toBe(OWNED.id);
    expect(supabase.state.removed).toContain(OWNED.storage_path);
    expect(supabase.state.removed).toContain(OWNED.variants.thumb);
  });

  it('refuses another guest’s upload', async () => {
    const theirs = { ...OWNED, metadata: { source: 'guest', client_id: '99999999-1111-4111-8111-111111111111' } };
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: theirs });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
    expect(res.statusCode).toBe(404);
    expect(supabase.state.removed).toHaveLength(0);
  });

  it('refuses admin-uploaded media even with a matching client_id', async () => {
    const adminRow = { ...OWNED, metadata: { client_id: CLIENT_ID } }; // no source:'guest'
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: adminRow });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('refuses media belonging to a different event', async () => {
    const otherEvent = { ...OWNED, host_id: '12121212-3434-4545-8656-767878789090' };
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: otherEvent });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s a missing row rather than leaking that it is absent', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: null });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('rate-limits deletes per client', async () => {
    const { deps } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: OWNED, denyRateKeys: [`delete:${CLIENT_ID}`] });
    const routes = createGuestRoutes(deps);
    const res = mockRes();
    await routes.deleteMine(req({ body: { client_id: CLIENT_ID, media_id: OWNED.id } }), res);
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

  // Guests upload the same way all day; the event's start decides.
  it('files uploads before the event starts under Getting ready', async () => {
    const albumFor = async (eventStart, overrides = {}) => {
      const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: { ...EVENT_ROW, event_start: eventStart }, existingMedia: null });
      stubHeadResponse(headOk());
      await createGuestRoutes(deps).completeUploads(req({ body: { tickets: [ticketFor(overrides)] } }), mockRes());
      return supabase.state.inserted[0].metadata.album;
    };
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(await albumFor(inAnHour)).toBe('ready');
    expect(await albumFor(anHourAgo)).toBe('day');
    // No start time, no before.
    expect(await albumFor(null)).toBe('day');
    // The booth's posters go to the booth, before the start or not.
    expect(await albumFor(inAnHour, { booth: true })).toBe('booth');
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


describe('booth pictures are kept, and posted only when the guest chooses', () => {
  const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('selfie').toString('base64');
  const MEDIA = '77777777-2222-4333-8444-555555555555';
  const BOOTH_LINK = { ...ACTIVE_LINK, allow_face_filter: true };

  beforeEach(() => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'test-placeholder';
    provider.runStyle.mockResolvedValue({ ok: true, image: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg' });
  });
  afterEach(() => {
    delete process.env.BOOTH_PROVIDER;
    delete process.env.FAL_API_KEY;
  });

  const generate = async (body, config = {}) => {
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, ...config });
    const res = mockRes();
    await createGuestRoutes(deps).faceFilter(req({ body: { client_id: CLIENT_ID, image: PHOTO, effect: 'decade-1970s', ...body } }), res);
    return { res, supabase };
  };

  it('stores every picture it makes, unposted, against the guest', async () => {
    const { res, supabase } = await generate({ return: 'url', guest_name: 'Auntie Carol' });
    expect(res.statusCode).toBe(200);
    const row = supabase.state.inserted.find((r) => r.metadata?.album === 'booth');
    expect(row.metadata.posted).toBe(false);
    expect(row.metadata.client_id).toBe(CLIENT_ID);
    expect(row.metadata.source).toBe('guest');
    expect(row.metadata.guest_name).toBe('Auntie Carol');
    expect(row.metadata.look).toBe('Seventies lounge');
    expect(supabase.state.uploads.some((u) => u.path === row.storage_path)).toBe(true);
    expect(res.body.media_id).toBe(row.id);
  });

  // The memory fix: a room full of guests must not hold every picture
  // in the API process as base64.
  it('answers with a URL, not the picture, for a current page', async () => {
    const { res } = await generate({ return: 'url' });
    expect(res.body.image_url).toContain('/booth.jpg');
    expect(res.body.image).toBeUndefined();
  });

  it('still answers inline for a page from before the change', async () => {
    const { res } = await generate({});
    expect(res.body.image).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('still hands the guest their picture if keeping it fails', async () => {
    const { res } = await generate({ return: 'url' }, { uploadErrorOn: '/booth.' });
    expect(res.statusCode).toBe(200);
    expect(res.body.media_id).toBeNull();
    expect(res.body.image).toMatch(/^data:image\/jpeg;base64,/);
  });

  // A kept picture is invisible to everyone until posted.
  it('keeps unposted pictures out of the feed and out of "Yours"', async () => {
    const orCalls = [];
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, mediaRows: [] });
    const realFrom = supabase.from;
    supabase.from = (t) => { const b = realFrom(t); const or = b.or; b.or = (f) => { orCalls.push(f); return or(f); }; return b; };
    const routes = createGuestRoutes(deps);
    await routes.listMedia(req(), mockRes());
    await routes.listMine(req({ body: { client_id: CLIENT_ID } }), mockRes());
    const filter = 'metadata->>posted.is.null,metadata->>posted.neq.false';
    expect(orCalls.filter((f) => f === filter)).toHaveLength(2);
  });

  const post = async (existingMedia, body = {}) => {
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, existingMedia });
    const res = mockRes();
    await createGuestRoutes(deps).postBooth(req({ body: { client_id: CLIENT_ID, media_id: MEDIA, ...body } }), res);
    return { res, supabase };
  };
  const kept = (over = {}) => ({
    id: MEDIA, host_kind: 'event', host_id: EVENT_ID, storage_path: `event/${EVENT_ID}/${MEDIA}/booth.jpg`,
    metadata: { source: 'guest', client_id: CLIENT_ID, album: 'booth', posted: false, look: '1970s' },
    ...over,
  });

  it('posting puts it on the projector, dated now, and makes its layers', async () => {
    const before = Date.now();
    const { res, supabase } = await post(kept());
    expect(res.statusCode).toBe(200);
    const upd = supabase.state.updated.find((u) => u.table === 'host_media').fields;
    expect(upd.metadata.posted).toBe(true);
    expect(upd.metadata.look).toBe('1970s');
    expect(Date.parse(upd.created_at)).toBeGreaterThanOrEqual(before);
    expect(supabase.state.invoked[0].name).toBe('media-process-image');
  });

  it('refuses a picture that is not this device\'s, identically', async () => {
    for (const row of [
      null,
      kept({ metadata: { ...kept().metadata, client_id: '99999999-2222-4333-8444-555555555555' } }),
      kept({ host_id: '99999999-2222-4333-8444-555555555555' }),
      kept({ metadata: { ...kept().metadata, source: 'admin' } }),
      // An ordinary upload is not the booth's to post.
      kept({ metadata: { source: 'guest', client_id: CLIENT_ID, album: 'day' } }),
    ]) {
      const { res, supabase } = await post(row);
      expect(res.statusCode).toBe(404);
      expect(supabase.state.updated ?? []).toHaveLength(0);
    }
  });

  it('posting twice is harmless', async () => {
    const { res, supabase } = await post(kept({ metadata: { ...kept().metadata, posted: true } }));
    expect(res.statusCode).toBe(200);
    expect(res.body.already).toBe(true);
    expect(supabase.state.updated ?? []).toHaveLength(0);
  });

  it('rejects malformed ids before touching the database', async () => {
    const { res } = await post(kept(), { media_id: "x' or 1=1" });
    expect(res.statusCode).toBe(400);
  });
});

describe('guests pick themselves from the invitation list', () => {
  const DAN = 'aaaaaaaa-0000-4000-8000-00000000da01';
  const DAVID = 'aaaaaaaa-0000-4000-8000-00000000da02';
  const INVITES = {
    data: [
      { invite_party_members: { id: DAN, first_name: 'Dan', last_name: 'Baker' } },
      { invite_party_members: { id: DAVID, first_name: 'David', last_name: 'Jones' } },
    ],
    error: null,
  };
  const withList = (blocked = [], over = {}) => ({
    link: { ...ACTIVE_LINK, allow_face_filter: true },
    event: EVENT_ROW,
    tables: {
      invite_party_member_events: INVITES,
      events_media_guest_blocks: { data: blocked.map((member_id) => ({ member_id })), error: null },
    },
    ...over,
  });
  const run = async (fn, config, request) => {
    const { deps, supabase } = makeDeps(config);
    const res = mockRes();
    await createGuestRoutes(deps)[fn](req(request), res);
    return { res, supabase };
  };
  const ticketPayload = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
  const FILE = [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }];

  it('tells the page there is a guest list, or that there is not', async () => {
    expect((await run('getLink', withList(), {})).res.body.settings.guest_list).toBe(true);
    const none = { link: ACTIVE_LINK, event: EVENT_ROW, tables: { invite_party_member_events: { data: null, error: { message: 'relation does not exist' } } } };
    expect((await run('getLink', none, {})).res.body.settings.guest_list).toBe(false);
  });

  it('suggests matching names, a couple of letters in', async () => {
    const { res } = await run('searchGuests', withList(), { query: { q: 'da' } });
    expect(res.body.guests).toEqual([{ id: DAN, name: 'Dan Baker' }, { id: DAVID, name: 'David Jones' }]);
    expect((await run('searchGuests', withList(), { query: { q: 'd' } })).res.body.guests).toEqual([]);
  });

  it('has nothing to search on an event without invitations', async () => {
    const none = { link: ACTIVE_LINK, event: EVENT_ROW, tables: { invite_party_member_events: { data: [], error: null } } };
    expect((await run('searchGuests', none, { query: { q: 'da' } })).res.statusCode).toBe(404);
  });

  // No new names: an upload must name someone on the list.
  it('refuses an upload without a guest from the list', async () => {
    for (const member_id of [undefined, 'Dan', 'bbbbbbbb-0000-4000-8000-000000000000']) {
      const { res } = await run('mintUploads', withList(), { body: { client_id: CLIENT_ID, guest_name: 'Somebody New', member_id, files: FILE } });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('guest_required');
    }
  });

  it('records the guest, named as on the invitation, whatever the phone says', async () => {
    const { res } = await run('mintUploads', withList(), { body: { client_id: CLIENT_ID, guest_name: 'The Real Dan', member_id: DAN, files: FILE } });
    expect(res.statusCode).toBe(200);
    const p = ticketPayload(res.body.items[0].ticket);
    expect(p.member_id).toBe(DAN);
    expect(p.guest_name).toBe('Dan Baker');
  });

  it('turns a blocked guest away at every door', async () => {
    const mint = await run('mintUploads', withList([DAN]), { body: { client_id: CLIENT_ID, member_id: DAN, files: FILE } });
    expect(mint.res.statusCode).toBe(403);
    expect(mint.res.body.error).toBe('guest_blocked');

    provider.runStyle.mockClear();
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'test-placeholder';
    try {
      const booth = await run('faceFilter', withList([DAN]), {
        body: { client_id: CLIENT_ID, member_id: DAN, effect: 'decade-1970s', image: 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64') },
      });
      expect(booth.res.statusCode).toBe(403);
      // Refused before any money was spent.
      expect(provider.runStyle).not.toHaveBeenCalled();
    } finally {
      delete process.env.BOOTH_PROVIDER;
      delete process.env.FAL_API_KEY;
    }

    const post = await run('postBooth', withList([DAN], {
      existingMedia: {
        id: '77777777-2222-4333-8444-555555555555', host_kind: 'event', host_id: EVENT_ID, storage_path: 'x',
        metadata: { source: 'guest', client_id: CLIENT_ID, album: 'booth', posted: false, member_id: DAN },
      },
    }), { body: { client_id: CLIENT_ID, media_id: '77777777-2222-4333-8444-555555555555' } });
    expect(post.res.statusCode).toBe(403);
  });

  it('drops an upload whose guest was blocked after it started', async () => {
    const ticket = ticketFor({ member_id: DAN });
    const { deps, supabase } = makeDeps({ ...withList([DAN]), existingMedia: null });
    const res = mockRes();
    await createGuestRoutes(deps).completeUploads(req({ body: { tickets: [ticket] } }), res);
    expect(res.body.items[0].error).toBe('guest_blocked');
    expect(supabase.state.inserted).toHaveLength(0);
    expect(supabase.state.removed.length).toBeGreaterThan(0);
  });

  it('keeps a blocked guest\'s photos out of the feed, and nobody else\'s', async () => {
    const orCalls = [];
    const { deps, supabase } = makeDeps({ ...withList([DAN]), mediaRows: [] });
    const realFrom = supabase.from;
    supabase.from = (t) => { const b = realFrom(t); const or = b.or; b.or = (f) => { orCalls.push(f); return or(f); }; return b; };
    await createGuestRoutes(deps).listMedia(req(), mockRes());
    expect(orCalls).toContain(`metadata->>member_id.is.null,metadata->>member_id.not.in.(${DAN})`);

    const clear = [];
    const two = makeDeps({ ...withList([]), mediaRows: [] });
    const rf = two.supabase.from;
    two.supabase.from = (t) => { const b = rf(t); const or = b.or; b.or = (f) => { clear.push(f); return or(f); }; return b; };
    await createGuestRoutes(two.deps).listMedia(req(), mockRes());
    expect(clear.some((f) => f.includes('member_id'))).toBe(false);
  });
});


describe('taking a booth picture back off the big screen', () => {
  const MEDIA = '77777777-2222-4333-8444-555555555555';
  const row = (over = {}) => ({
    id: MEDIA, host_kind: 'event', host_id: EVENT_ID,
    metadata: { source: 'guest', client_id: CLIENT_ID, album: 'booth', posted: true, look: 'Synthwave' },
    ...over,
  });
  const unpost = async (existingMedia) => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia });
    const res = mockRes();
    await createGuestRoutes(deps).unpostBooth(req({ body: { client_id: CLIENT_ID, media_id: MEDIA } }), res);
    return { res, supabase };
  };

  it('marks it unposted and keeps everything else', async () => {
    const { res, supabase } = await unpost(row());
    expect(res.statusCode).toBe(200);
    const upd = supabase.state.updated[0].fields;
    expect(upd.metadata.posted).toBe(false);
    expect(upd.metadata.look).toBe('Synthwave');
    expect(Object.keys(upd)).toEqual(['metadata']);
  });

  it('works for a booth picture an older page uploaded rather than kept', async () => {
    const { metadata } = row();
    const { posted, ...legacy } = metadata;
    const { res } = await unpost(row({ metadata: legacy }));
    expect(res.statusCode).toBe(200);
  });

  it('refuses anyone else\'s picture, and anything not from the booth', async () => {
    for (const r of [
      null,
      row({ metadata: { ...row().metadata, client_id: '99999999-2222-4333-8444-555555555555' } }),
      row({ host_id: '99999999-2222-4333-8444-555555555555' }),
      row({ metadata: { ...row().metadata, album: 'day' } }),
    ]) {
      const { res, supabase } = await unpost(r);
      expect(res.statusCode).toBe(404);
      expect(supabase.state.updated ?? []).toHaveLength(0);
    }
  });
});


describe('one phone per name', () => {
  const DAN = 'aaaaaaaa-0000-4000-8000-00000000da01';
  const DAVID = 'aaaaaaaa-0000-4000-8000-00000000da02';
  const OTHER_PHONE = '11111111-1111-4111-8111-111111111111';
  const INVITES = { data: [
    { invite_party_members: { id: DAN, first_name: 'Dan', last_name: 'Baker' } },
    { invite_party_members: { id: DAVID, first_name: 'David', last_name: 'Jones' } },
  ], error: null };
  const cfg = (over = {}) => ({
    link: ACTIVE_LINK, event: EVENT_ROW,
    tables: { invite_party_member_events: INVITES, events_media_guest_blocks: { data: [], error: null } },
    ...over,
  });
  const run = async (fn, config, request) => {
    const { deps, supabase } = makeDeps(config);
    const res = mockRes();
    await createGuestRoutes(deps)[fn](req(request), res);
    return { res, supabase };
  };

  it('hides a name another phone has chosen, but not from that phone', async () => {
    const theirs = await run('searchGuests', cfg({ claims: { [DAN]: OTHER_PHONE } }), { query: { q: 'da', client_id: CLIENT_ID } });
    expect(theirs.res.body.guests.map((g) => g.name)).toEqual(['David Jones']);
    const mine = await run('searchGuests', cfg({ claims: { [DAN]: CLIENT_ID } }), { query: { q: 'da', client_id: CLIENT_ID } });
    expect(mine.res.body.guests.map((g) => g.name)).toEqual(['Dan Baker', 'David Jones']);
  });

  it('lets the first phone claim a name and refuses the second', async () => {
    const first = await run('claimGuest', cfg(), { body: { client_id: CLIENT_ID, member_id: DAN } });
    expect(first.res.statusCode).toBe(200);
    expect(first.supabase.state.claims.get(DAN)).toBe(CLIENT_ID);
    const second = await run('claimGuest', cfg({ claims: { [DAN]: CLIENT_ID } }), { body: { client_id: OTHER_PHONE, member_id: DAN } });
    expect(second.res.statusCode).toBe(409);
    expect(second.res.body.error).toBe('name_taken');
  });

  it('refuses uploads under a name another phone holds', async () => {
    const { res } = await run('mintUploads', cfg({ claims: { [DAN]: OTHER_PHONE } }), {
      body: { client_id: CLIENT_ID, member_id: DAN, files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 }] },
    });
    expect(res.statusCode).toBe(409);
  });

  // Switching names and back: the photos are the guest's, not the phone's.
  it('lists the claimed guest\'s photos, from any phone that holds the name', async () => {
    let filter = null;
    const { deps, supabase } = makeDeps(cfg({ claims: { [DAN]: CLIENT_ID }, mediaRows: [] }));
    const realFrom = supabase.from;
    supabase.from = (t) => { const b = realFrom(t); if (t === 'host_media') { const c = b.contains; b.contains = (col, v) => { filter = v; return c(col, v); }; } return b; };
    const res = mockRes();
    await createGuestRoutes(deps).listMine(req({ body: { client_id: CLIENT_ID, member_id: DAN } }), res);
    expect(res.statusCode).toBe(200);
    expect(filter).toEqual({ source: 'guest', member_id: DAN });
  });

  it('lets the phone holding a name remove that guest\'s photos, and nobody else', async () => {
    const photo = { id: '44444444-2222-4333-8444-555555555555', host_kind: 'event', host_id: EVENT_ID, storage_path: 'x', variants: {},
      metadata: { source: 'guest', client_id: '22222222-2222-4222-8222-222222222222', member_id: DAN } };
    const holder = await run('deleteMine', cfg({ claims: { [DAN]: CLIENT_ID }, existingMedia: photo }), { body: { client_id: CLIENT_ID, media_id: photo.id } });
    expect(holder.res.statusCode).toBe(200);
    const other = await run('deleteMine', cfg({ claims: { [DAN]: OTHER_PHONE }, existingMedia: photo }), { body: { client_id: CLIENT_ID, media_id: photo.id } });
    expect(other.res.statusCode).toBe(404);
  });

  it('releases a name only for the phone that holds it', async () => {
    const { res } = await run('releaseGuest', cfg({ claims: { [DAN]: CLIENT_ID } }), { body: { client_id: CLIENT_ID, member_id: DAN } });
    expect(res.statusCode).toBe(200);
  });
});


describe('background plates are checked for people', () => {
  const IMG = { ok: true, image: new Uint8Array([9]), contentType: 'image/jpeg' };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const complete = async () => {
    const { deps, supabase } = makeDeps({ link: ACTIVE_LINK, event: EVENT_ROW, existingMedia: null });
    const updates = [];
    const realFrom = supabase.from;
    supabase.from = (t) => { const b = realFrom(t); const u = b.update; b.update = (f) => { if (f.variants) updates.push(f.variants); return u(f); }; return b; };
    stubHead({ ok: true, headers: { get: (k) => ({ 'content-length': '1000', 'content-type': 'image/jpeg' })[k] ?? null } });
    await createGuestRoutes(deps).completeUploads(req({ body: { tickets: [ticketFor()] } }), mockRes());
    await settle();
    return { updates, supabase };
  };
  const path = `event/${EVENT_ID}/11111111-2222-3333-4444-555555555555/photo.jpg`;

  beforeEach(() => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'test-placeholder';
    provider.runPlate.mockReset();
    provider.plateHasPeople.mockReset();
  });
  afterEach(() => {
    delete process.env.BOOTH_PROVIDER;
    delete process.env.FAL_API_KEY;
  });

  it('keeps a clean plate', async () => {
    provider.runPlate.mockResolvedValue(IMG);
    provider.plateHasPeople.mockResolvedValue(false);
    const { updates } = await complete();
    expect(provider.runPlate).toHaveBeenCalledTimes(1);
    expect(updates.at(-1).plate).toMatch(/variants\/plate\.jpg$/);
  });

  it('retries once, firmly, when the plate still shows a person', async () => {
    provider.runPlate.mockResolvedValue(IMG);
    provider.plateHasPeople.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { updates } = await complete();
    expect(provider.runPlate).toHaveBeenCalledTimes(2);
    expect(provider.runPlate.mock.calls[1][1]).toBe(true);
    expect(updates.at(-1).plate).toMatch(/variants\/plate\.jpg$/);
  });

  // The double-exposure fault: never keep a plate with a person in it.
  it('falls back to the photo itself (shown flat) when both attempts keep a person', async () => {
    provider.runPlate.mockResolvedValue(IMG);
    provider.plateHasPeople.mockResolvedValue(true);
    const { updates } = await complete();
    expect(updates.at(-1).plate).toBe(path);
  });

  it('keeps the plate when the check cannot run', async () => {
    provider.runPlate.mockResolvedValue(IMG);
    provider.plateHasPeople.mockResolvedValue(null);
    const { updates } = await complete();
    expect(provider.runPlate).toHaveBeenCalledTimes(1);
    expect(updates.at(-1).plate).toMatch(/variants\/plate\.jpg$/);
  });
});


describe('poses and fingers in the booth', () => {
  const BOOTH_LINK = { ...ACTIVE_LINK, allow_face_filter: true };
  const PHOTO_ = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');
  const shoot = async (body, config = {}) => {
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, ...config });
    const res = mockRes();
    await createGuestRoutes(deps).faceFilter(req({ body: { client_id: CLIENT_ID, image: PHOTO_, effect: 'decade-1970s', ...body } }), res);
    return { res, supabase };
  };
  beforeEach(() => {
    process.env.BOOTH_PROVIDER = 'fal';
    process.env.FAL_API_KEY = 'test-placeholder';
    provider.runStyle.mockReset();
    provider.runStyle.mockResolvedValue({ ok: true, image: new Uint8Array([1]), contentType: 'image/jpeg' });
    provider.readFingers.mockReset();
    provider.readFingers.mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env.BOOTH_PROVIDER;
    delete process.env.FAL_API_KEY;
  });

  // An organiser wants to see what the guest actually took, next to what
  // the model made of it (asked 2026-09-23).
  it('keeps the selfie beside the picture it became', async () => {
    const { res, supabase } = await shoot({ return: 'url' });
    expect(res.statusCode).toBe(200);
    const row = supabase.state.inserted.find((r) => r.metadata?.album === 'booth');
    expect(row.metadata.selfie).toBe(`event/${EVENT_ID}/${row.id}/selfie.jpg`);
    expect(supabase.state.uploads.some((u) => u.path === row.metadata.selfie)).toBe(true);
  });

  it('takes the selfie away when the guest deletes the picture', async () => {
    const photo = {
      id: '44444444-2222-4333-8444-666666666666', host_kind: 'event', host_id: EVENT_ID,
      storage_path: `event/${EVENT_ID}/x/booth.jpg`, variants: {},
      metadata: { source: 'guest', client_id: CLIENT_ID, album: 'booth', selfie: `event/${EVENT_ID}/x/selfie.jpg` },
    };
    const { deps, supabase } = makeDeps({ link: BOOTH_LINK, event: EVENT_ROW, existingMedia: photo });
    await createGuestRoutes(deps).deleteMine(req({ body: { client_id: CLIENT_ID, media_id: photo.id } }), mockRes());
    expect(supabase.state.removed.flat()).toContain(`event/${EVENT_ID}/x/selfie.jpg`);
  });

  it('tells the model the pose, and records it against the picture', async () => {
    const { res, supabase } = await shoot({ pose: 'huddle', return: 'url' });
    expect(res.statusCode).toBe(200);
    expect(provider.runStyle.mock.calls[0][1]).toMatch(/heads pressed together in a tight huddle/);
    expect(res.body.pose).toEqual({ id: 'huddle', label: 'The huddle' });
    const row = supabase.state.inserted.find((r) => r.metadata?.album === 'booth');
    expect(row.metadata.pose).toBe('huddle');
  });

  // A pose is a fixed list; anything else is simply not a pose.
  it('ignores a pose it does not know', async () => {
    const { res } = await shoot({ pose: 'do a backflip off the bar' });
    expect(res.statusCode).toBe(200);
    expect(provider.runStyle.mock.calls[0][1]).not.toMatch(/backflip/);
    expect(res.body.pose).toBeNull();
  });

  it('picks from the American board when the guest has chosen America', async () => {
    provider.readFingers.mockResolvedValue(2);
    const { res } = await shoot({ fingers: true, decade: '1970s', place: 'us' });
    const { BOOTH_ERAS } = await import('../../lib/booth-eras.js');
    expect(res.body.effect.id).toBe(BOOTH_ERAS.find((e) => e.key === '1970s').looks.us[2]);
    expect(res.body.place).toBe('us');
  });

  it('lets the fingers in the photo choose the look', async () => {
    provider.readFingers.mockResolvedValue(3);
    const { res, supabase } = await shoot({ fingers: true, decade: '1970s', return: 'url' });
    expect(res.statusCode).toBe(200);
    // The 1970s looks, after the decade itself: the third is theirs.
    const { BOOTH_ERAS } = await import('../../lib/booth-eras.js');
    // The British board, since no place was asked for.
    const expected = BOOTH_ERAS.find((e) => e.key === '1970s').looks.uk[3];
    expect(res.body.effect.id).toBe(expected);
    expect(res.body.fingers).toBe(3);
    const row = supabase.state.inserted.find((r) => r.metadata?.album === 'booth');
    expect(row.metadata.look_id).toBe(expected);
  });

  // Never waste a guest's photo on a hand the model could not read.
  it('keeps the look they picked when no fingers are held up, or the read fails', async () => {
    for (const answer of [0, null, 9]) {
      provider.readFingers.mockResolvedValue(answer);
      const { res } = await shoot({ fingers: true, decade: '1970s' });
      expect(res.body.effect.id).toBe('decade-1970s');
      expect(res.body.fingers).toBe(answer === 9 ? 9 : answer);
    }
  });

  it('does not pay for a finger read unless the booth asked for one', async () => {
    await shoot({ decade: '1970s' });
    expect(provider.readFingers).not.toHaveBeenCalled();
    await shoot({ fingers: true });
    expect(provider.readFingers).not.toHaveBeenCalled(); // no decade, no looks to choose from
  });
});
