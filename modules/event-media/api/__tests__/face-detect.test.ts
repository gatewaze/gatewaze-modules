import { describe, expect, it, vi } from 'vitest';
import { createFaceDetect } from '../face-detect';

const EVENT = '99999999-8888-7777-6666-555555555555';
const OTHER = '11111111-2222-3333-4444-555555555555';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function mockRes() {
  const res: any = {
    statusCode: 0, body: null,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  return res;
}

/**
 * A database with `photos` images on one event, the ids in `scanned`
 * already done. Only the chain face-detect actually uses.
 */
function fakeDb(photos: Array<{ id: string; created_at: string }>, scanned: Set<string>) {
  const calls = {
    windows: 0, scanLookups: 0, longestInList: 0,
    deleted: [] as any[], inserted: [] as any[], upserted: [] as any[],
  };
  function builder(table: string) {
    const f: any[] = [];
    let lt: string | null = null;
    let lim = Infinity;
    let inSet: string[] | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { f.push([c, v]); return b; },
      like: () => b,
      order: () => b,
      limit: (n: number) => { lim = n; return b; },
      lt: (_c: string, v: string) => { lt = v; return b; },
      in: (_c: string, vs: string[]) => {
        inSet = vs;
        // What PostgREST would put in the URL. A 500-uuid list is ~18KB
        // and the gateway refuses it -- that is the bug this pins.
        calls.longestInList = Math.max(calls.longestInList, vs.length);
        return b;
      },
      not: () => b,
      maybeSingle: async () => {
        // Ownership check: the photo must be on this event.
        const id = f.find(([c]) => c === 'id')?.[1];
        const host = f.find(([c]) => c === 'host_id')?.[1];
        const ok = photos.some((p) => p.id === id) && host === EVENT;
        return { data: ok ? { id } : null, error: null };
      },
      delete: () => { calls.deleted.push(f); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      insert: async (rows: any) => { calls.inserted.push(rows); return { error: null }; },
      upsert: async (row: any) => { calls.upserted.push(row); return { error: null }; },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'host_media') {
          calls.windows += 1;
          let rows = [...photos].sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1));
          if (lt) rows = rows.filter((r) => r.created_at < lt!);
          return resolve({
            data: rows.slice(0, lim).map((r) => ({
              ...r, storage_path: `${r.id}.jpg`, width: 4000, height: 2667,
              // Embedded through the foreign key, as PostgREST returns it.
              events_media_face_scans: scanned.has(r.id) ? { model_id: 'm' } : null,
            })),
            error: null,
          });
        }
        if (table === 'events_media_face_scans') {
          calls.scanLookups += 1;
          const pool = inSet ?? photos.map((p) => p.id);
          return resolve({ data: pool.filter((id) => scanned.has(id)).map((media_id) => ({ media_id })), error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { from: (t: string) => builder(t), calls };
}

const deps = (db: any) => ({
  canAdminEvent: async () => true,
  serviceClient: db,
  sizedUrl: (path: string, w: number) => `https://cdn/${path}?width=${w}`,
  logger,
});

const req = (over: any = {}) => ({ params: { eventId: EVENT }, body: {}, ...over });

/** Walk `pending` the way the browser does, carrying the cursor. */
async function walkAll(db: any, limit = 50) {
  const routes = createFaceDetect(deps(db) as any);
  const seen: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i += 1) {
    const res = mockRes();
    await routes.pending(req({ body: { limit, model_id: 'm', after } }), res);
    expect(res.statusCode).toBe(200);
    const { items, exhausted, cursor } = res.body;
    if (cursor === after && items.length === 0) break;
    after = cursor ?? after;
    seen.push(...items.map((i2: any) => i2.id));
    if (items.length === 0 && exhausted) break;
    if (exhausted && items.length === 0) break;
    if (exhausted && seen.length >= 1 && items.length === 0) break;
    if (exhausted) { break; }
  }
  return seen;
}

/** A uuid-shaped id built from a counter, so ids are stable and valid. */
const idOf = (i: number) => {
  const h = String(i).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${h}`;
};

const album = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: idOf(i),
  // Newest first by created_at; index 0 is the newest.
  created_at: new Date(2026, 0, 1, 0, 0, n - i).toISOString(),
}));

describe('pending', () => {
  it('offers every photograph of a small album', async () => {
    const photos = album(12);
    const db = fakeDb(photos, new Set());
    const seen = await walkAll(db, 50);
    expect(new Set(seen).size).toBe(12);
  });

  // The bug this exists for. The first version fetched a fixed slice of
  // the newest photographs and filtered the scanned ones out of it in
  // memory, so once that slice was done it returned nothing and the
  // browser stopped -- leaving everything older unscanned for ever.
  it('reaches past a whole window of already-scanned photographs', async () => {
    const photos = album(1200);
    // Everything except the oldest 51 is already done -- the shape of
    // an 851-photo album scanned by a build with the old bug.
    const scanned = new Set(photos.slice(0, 1149).map((p) => p.id));
    const db = fakeDb(photos, scanned);

    const res = mockRes();
    await createFaceDetect(deps(db) as any).pending(
      req({ body: { limit: 50, model_id: 'm' } }), res,
    );
    expect(res.statusCode).toBe(200);
    // It must have walked past the scanned ones rather than giving up.
    expect(res.body.items.length).toBe(50);
    expect(res.body.items.every((i: any) => !scanned.has(i.id))).toBe(true);
    expect(db.calls.windows).toBeGreaterThan(1);
  });

  // The scan died in production with "fetch failed" after eight
  // seconds: the scanned-already lookup was an `in.(...)` of up to 500
  // uuids, which PostgREST puts in the URL -- about 18KB of it -- and
  // the gateway refused the request. The join the database already
  // knows how to do costs one round trip and no url at all.
  it('never builds a filter long enough for a gateway to refuse', async () => {
    const photos = album(1200);
    const db = fakeDb(photos, new Set(photos.slice(0, 900).map((p) => p.id)));
    const res = mockRes();
    await createFaceDetect(deps(db) as any).pending(req({ body: { limit: 50, model_id: 'm' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items.length).toBe(50);
    // No `in` list at all now: the scan arrives with the photograph.
    expect(db.calls.longestInList).toBe(0);
  });

  it('asks the database for the scan alongside the photograph', async () => {
    const photos = album(1200);
    const db = fakeDb(photos, new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any).pending(req({ body: { limit: 10, model_id: 'm' } }), res);
    // One trip per window, carrying both. A separate lookup would be
    // either a huge url or a truncated answer.
    expect(db.calls.scanLookups).toBe(0);
    expect(db.calls.windows).toBeGreaterThan(0);
  });

  it('says when it has run out of album', async () => {
    const db = fakeDb(album(5), new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any).pending(req({ body: { limit: 50, model_id: 'm' } }), res);
    expect(res.body.exhausted).toBe(true);
    expect(res.body.items).toHaveLength(5);
  });

  it('moves the cursor forward so a second request does not repeat the first', async () => {
    const photos = album(120);
    const db = fakeDb(photos, new Set());
    const routes = createFaceDetect(deps(db) as any);
    const a = mockRes();
    await routes.pending(req({ body: { limit: 20, model_id: 'm' } }), a);
    const b = mockRes();
    await routes.pending(req({ body: { limit: 20, model_id: 'm', after: a.body.cursor } }), b);
    const first = new Set(a.body.items.map((i: any) => i.id));
    expect(b.body.items.every((i: any) => !first.has(i.id))).toBe(true);
  });

  it('refuses without a model id, because scanned-by-what is the question', async () => {
    const res = mockRes();
    await createFaceDetect(deps(fakeDb(album(3), new Set())) as any)
      .pending(req({ body: { limit: 10 } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an eventId that is not a uuid', async () => {
    const res = mockRes();
    await createFaceDetect(deps(fakeDb([], new Set())) as any)
      .pending({ params: { eventId: 'nope' }, body: { model_id: 'm' } } as any, res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses somebody who may not manage the event', async () => {
    const res = mockRes();
    const routes = createFaceDetect({ ...deps(fakeDb([], new Set())), canAdminEvent: async () => false } as any);
    await routes.pending(req({ body: { model_id: 'm' } }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe('record', () => {
  const photos = album(3);
  const one = photos[0]!.id;

  it('keeps only the fields it knows, whatever else is sent', async () => {
    const db = fakeDb(photos, new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any).record(req({
      body: {
        media_id: OTHER, model_id: 'm',
        faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, is_admin: true, event_id: 'elsewhere' }],
      },
    }), res);
    // media_id is not one of this event's photographs.
    expect(res.statusCode).toBe(404);
  });

  it('writes an allowlisted row and nothing else', async () => {
    const db = fakeDb(photos, new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any).record(req({
      body: {
        media_id: one, model_id: 'm', took_ms: 12.7,
        faces: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, score: 0.9, px: 120.6, sneaky: 'x' }],
      },
    }), res);
    expect(res.statusCode).toBe(200);
    const row = db.calls.inserted[0][0];
    expect(Object.keys(row).sort()).toEqual([
      'box_h', 'box_w', 'box_x', 'box_y', 'event_id', 'face_index', 'face_px', 'media_id', 'model_id', 'score',
    ]);
    // Integer columns get integers, or the insert fails AFTER the
    // delete has already removed the old boxes.
    expect(Number.isInteger(row.face_px)).toBe(true);
    expect(Number.isInteger(db.calls.upserted[0].took_ms)).toBe(true);
  });

  it('drops a face with a value out of range rather than storing it', async () => {
    const db = fakeDb(photos, new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any).record(req({
      body: {
        media_id: one, model_id: 'm',
        faces: [
          { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 5 },        // score out of range
          { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: '0.9' },    // a string
          { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.8 },      // kept
        ],
      },
    }), res);
    expect(res.body.faces).toBe(1);
  });

  it('records a photograph with no faces, so it is not offered for ever', async () => {
    const db = fakeDb(photos, new Set());
    const res = mockRes();
    await createFaceDetect(deps(db) as any)
      .record(req({ body: { media_id: one, model_id: 'm', faces: [] } }), res);
    expect(res.statusCode).toBe(200);
    expect(db.calls.upserted[0].faces).toBe(0);
  });
});
