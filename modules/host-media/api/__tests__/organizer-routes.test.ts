// @ts-nocheck — vitest harness; route handlers are @ts-nocheck'd already.

/**
 * Organizer endpoints (bulk edit/delete, custom order, album items) and
 * the per-host authorizer. Uses an in-memory Supabase fake that really
 * applies eq/in filters, so host scoping is exercised rather than mocked
 * away: an id belonging to another host must never be touched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMediaRoutes } from '../routes.js';
import { createAlbumsRoutes } from '../albums-routes.js';
import { createHostAuthorizer } from '../../lib/authorize-host.js';
import { _resetRegistryForTests, registerHostMediaConsumer } from '../../lib/registry.js';

const EVENT_A = '7ffd554a-21d1-452d-a3ec-bcf952fb1652';
const EVENT_B = '8ffd554a-21d1-452d-a3ec-bcf952fb1653';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M_OTHER = '33333333-3333-4333-8333-333333333333';
const ALBUM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALBUM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>, rpcs: Record<string, (args: Row) => unknown> = {}) {
  const calls: Array<{ rpc: string; args: Row }> = [];
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    const rows = () => (tables[table] ??= []);
    const matching = () => rows().filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op === 'update') {
        const hit = matching();
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = new Set(matching());
        tables[table] = rows().filter((r) => !hit.has(r));
        return { data: [...hit], error: null };
      }
      return { data: matching(), error: null };
    };
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
      in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return b; },
      like: () => b,
      or: () => b,
      order: () => b,
      range: () => b,
      limit: () => b,
      update: (p: Row) => { op = 'update'; patch = p; return b; },
      delete: () => { op = 'delete'; return b; },
      insert: (r: Row | Row[]) => { (Array.isArray(r) ? r : [r]).forEach((x) => rows().push({ ...x })); return { select: () => ({ single: async () => ({ data: r, error: null }) }) }; },
      upsert: async (r: Row[]) => { r.forEach((x) => rows().push({ ...x })); return { data: r, error: null }; },
      maybeSingle: async () => { const { data } = run(); return { data: data[0] ?? null, error: null }; },
      single: async () => { const { data } = run(); return { data: data[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    };
    return b;
  }
  return {
    calls,
    tables,
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Row) => {
      calls.push({ rpc: name, args });
      return { data: rpcs[name] ? rpcs[name](args) : null, error: null };
    },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(s: number) { res.statusCode = s; return res; },
    json(b: unknown) { res.body = b; return res; },
    setHeader(k: string, v: string) { res.headers[k] = v; return res; },
    end() { return res; },
  };
  return res;
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function media(id: string, hostId: string, extra: Row = {}): Row {
  return { id, host_kind: 'event', host_id: hostId, storage_path: `event/${hostId}/${id}/a.jpg`, mime_type: 'image/jpeg', bytes: 10, used_in: [], variants: null, is_approved: false, ...extra };
}

function mediaRoutes(sb: ReturnType<typeof fakeSupabase>, deleted: string[] = []) {
  return createMediaRoutes({
    supabase: sb,
    mediaAdapter: {
      upload: async () => ({ storagePath: 'x', cdnUrl: 'x' }),
      delete: async (p: string) => { deleted.push(p); },
      getPublicUrl: (p: string) => `https://cdn.example/${p}`,
      getRenderUrl: (p: string, w: number) => `https://cdn.example/render/${p}?width=${w}`,
      createSignedUrl: async () => 'x',
    },
    parseUploadedFiles: async () => [],
    rateLimit: async () => ({ allowed: true, resetAt: 0 }),
    logger,
  });
}

beforeEach(() => {
  _resetRegistryForTests();
  registerHostMediaConsumer({ hostKind: 'event', enableAlbums: true, enableYouTube: false, enableZipUnpack: false });
});

describe('bulkPatchMedia', () => {
  it('approves only the ids that belong to the host in the URL', async () => {
    const sb = fakeSupabase({ host_media: [media(M1, EVENT_A), media(M_OTHER, EVENT_B)] });
    const res = mockRes();
    await mediaRoutes(sb).bulkPatchMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M1, M_OTHER], fields: { is_approved: true } } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ updated: [M1] });
    expect(sb.tables.host_media.find((r) => r.id === M_OTHER)!.is_approved).toBe(false);
  });

  it('rejects a wrongly typed field', async () => {
    const sb = fakeSupabase({ host_media: [media(M1, EVENT_A)] });
    const res = mockRes();
    await mediaRoutes(sb).bulkPatchMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M1], fields: { is_approved: 'yes' } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_field');
  });

  it('drops non-allowlisted fields (mass assignment)', async () => {
    const sb = fakeSupabase({ host_media: [media(M1, EVENT_A)] });
    const res = mockRes();
    await mediaRoutes(sb).bulkPatchMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M1], fields: { host_id: EVENT_B } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no_fields');
    expect(sb.tables.host_media[0].host_id).toBe(EVENT_A);
  });

  it('refuses to move media into another host album', async () => {
    const sb = fakeSupabase({
      host_media: [media(M1, EVENT_A)],
      host_media_albums: [{ id: ALBUM_B, host_kind: 'event', host_id: EVENT_B, name: 'Other' }],
    });
    const res = mockRes();
    await mediaRoutes(sb).bulkPatchMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M1], fields: { album_id: ALBUM_B } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_album');
    expect(sb.tables.host_media[0].album_id).toBeUndefined();
  });

  it('rejects a non-UUID in media_ids', async () => {
    const res = mockRes();
    await mediaRoutes(fakeSupabase({})).bulkPatchMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: ['nope'], fields: { is_featured: true } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_media_ids');
  });
});

describe('bulkDeleteMedia', () => {
  it('deletes unreferenced host media with variants, keeps referenced, ignores other hosts', async () => {
    const sb = fakeSupabase({
      host_media: [
        media(M1, EVENT_A, { variants: { thumb: `event/${EVENT_A}/${M1}/variants/thumb.jpg` } }),
        media(M2, EVENT_A, { used_in: [{ type: 'page', id: 'p', name: 'Home' }] }),
        media(M_OTHER, EVENT_B),
      ],
    });
    const deleted: string[] = [];
    const res = mockRes();
    await mediaRoutes(sb, deleted).bulkDeleteMedia(
      { params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M1, M2, M_OTHER] } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deleted: [M1], in_use: [M2], not_found: [M_OTHER] });
    expect(sb.tables.host_media.map((r) => r.id).sort()).toEqual([M2, M_OTHER].sort());
    expect(deleted).toEqual([`event/${EVENT_A}/${M1}/a.jpg`, `event/${EVENT_A}/${M1}/variants/thumb.jpg`]);
  });
});

describe('setMediaOrder', () => {
  it('passes the ordered ids to the set-order function scoped to the host', async () => {
    const sb = fakeSupabase({}, { host_media_set_display_order: (a) => (a.p_ids as string[]).length });
    const res = mockRes();
    await mediaRoutes(sb).setMediaOrder({ params: { hostKind: 'event', hostId: EVENT_A }, body: { media_ids: [M2, M1] } }, res);
    expect(res.statusCode).toBe(200);
    expect(sb.calls[0]).toEqual({ rpc: 'host_media_set_display_order', args: { p_host_kind: 'event', p_host_id: EVENT_A, p_ids: [M2, M1] } });
  });
});

describe('listMedia preview URLs', () => {
  it('uses a stored variant, else a render URL for images', async () => {
    const sb = fakeSupabase({
      host_media: [
        media(M1, EVENT_A, { variants: { thumb: 'v/thumb.jpg' } }),
        media(M2, EVENT_A),
      ],
    });
    const res = mockRes();
    await mediaRoutes(sb).listMedia({ params: { hostKind: 'event', hostId: EVENT_A }, query: {} }, res);
    const [a, b] = res.body.items;
    expect(a.thumb_url).toBe('https://cdn.example/v/thumb.jpg');
    expect(a.medium_url).toContain('render');
    expect(b.thumb_url).toBe(`https://cdn.example/render/event/${EVENT_A}/${M2}/a.jpg?width=350`);
  });
});

describe('album routes host scoping', () => {
  function tables() {
    return {
      host_media: [media(M1, EVENT_A), media(M2, EVENT_A), media(M_OTHER, EVENT_B)],
      host_media_albums: [
        { id: ALBUM_A, host_kind: 'event', host_id: EVENT_A, name: 'Ceremony' },
        { id: ALBUM_B, host_kind: 'event', host_id: EVENT_B, name: 'Other' },
      ],
      host_media_album_items: [{ id: 'i1', album_id: ALBUM_A, media_id: M1, sort_order: 10 }],
    };
  }

  it('bulk add skips existing members, ignores other hosts media, appends after the last item', async () => {
    const sb = fakeSupabase(tables());
    const res = mockRes();
    await createAlbumsRoutes({ supabase: sb, logger }).addItemToAlbum(
      { params: { hostKind: 'event', hostId: EVENT_A, id: ALBUM_A }, body: { media_ids: [M1, M2, M_OTHER] } },
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ added: [M2], already_in_album: [M1] });
    const added = sb.tables.host_media_album_items.find((r) => r.media_id === M2);
    expect(added!.sort_order).toBe(20);
  });

  it('refuses to add to an album of another host', async () => {
    const sb = fakeSupabase(tables());
    const res = mockRes();
    await createAlbumsRoutes({ supabase: sb, logger }).addItemToAlbum(
      { params: { hostKind: 'event', hostId: EVENT_A, id: ALBUM_B }, body: { media_id: M1 } },
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(sb.tables.host_media_album_items).toHaveLength(1);
  });

  it('refuses to remove from an album of another host', async () => {
    const t = tables();
    t.host_media_album_items.push({ id: 'i2', album_id: ALBUM_B, media_id: M_OTHER, sort_order: 10 });
    const sb = fakeSupabase(t);
    const res = mockRes();
    await createAlbumsRoutes({ supabase: sb, logger }).removeItemFromAlbum(
      { params: { hostKind: 'event', hostId: EVENT_A, id: ALBUM_B, mediaId: M_OTHER } },
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(sb.tables.host_media_album_items).toHaveLength(2);
  });

  it('lists only the host albums items', async () => {
    const t = tables();
    t.host_media_album_items.push({ id: 'i2', album_id: ALBUM_B, media_id: M_OTHER, sort_order: 10 });
    const res = mockRes();
    await createAlbumsRoutes({ supabase: fakeSupabase(t), logger }).listAlbumItems(
      { params: { hostKind: 'event', hostId: EVENT_A } },
      res,
    );
    expect(res.body.items.map((i) => i.id)).toEqual(['i1']);
  });

  it('rejects a cover image from another host', async () => {
    const res = mockRes();
    await createAlbumsRoutes({ supabase: fakeSupabase(tables()), logger }).patchAlbum(
      { params: { hostKind: 'event', hostId: EVENT_A, id: ALBUM_A }, body: { cover_media_id: M_OTHER } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_cover');
  });
});

describe('createHostAuthorizer', () => {
  function run(canAdmin: boolean, headers: Record<string, string> = { authorization: 'Bearer t' }, params = { hostKind: 'event', hostId: EVENT_A }) {
    const seen: Array<[string, string, string]> = [];
    const mw = createHostAuthorizer({
      supabaseUrl: 'http://x',
      anonKey: 'anon',
      logger,
      canAdmin: async (token, kind, id) => { seen.push([token, kind, id]); return canAdmin; },
    });
    const res = mockRes();
    let nextCalled = false;
    return mw({ params, headers } as never, res as never, () => { nextCalled = true; }).then(() => ({ res, nextCalled, seen }));
  }

  it('lets an admin of the host through', async () => {
    const { nextCalled, seen } = await run(true);
    expect(nextCalled).toBe(true);
    expect(seen).toEqual([['t', 'event', EVENT_A]]);
  });

  it('forbids a signed-in user who cannot administer the host', async () => {
    const { res, nextCalled } = await run(false);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('requires a token', async () => {
    const { res, nextCalled } = await run(true, {});
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown host kind before asking the database', async () => {
    const { res, seen } = await run(true, { authorization: 'Bearer t' }, { hostKind: 'nope', hostId: EVENT_A });
    expect(res.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});
