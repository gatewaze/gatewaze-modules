/**
 * The studio routes: the selection allowlist, and that every route authorises
 * against the video before the service role reads or writes anything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountStudioRoutes, sanitiseSelection, isStale } from '../api/studio-routes.js';
import { cliUploadCommand } from '../api/editor-routes.js';

const analysis = { duration: 600, cuts: [{ key: 'cut-10' }, { key: 'cut-20' }] };

describe('sanitiseSelection', () => {
  it('keeps only known fields, within range, and only a cut the analysis made', () => {
    const s = sanitiseSelection({
      cut: 'cut-20', scale: 3, x: 0.1, lead: ' Lead ', emph: 'Big words', panels: false,
      trim_in: 30, trim_out: 9999, preroll: 'yes', card_title: ' A title ', card_speakers: [{ name: ' Dex ', role: '', company: 'HumanLayer', extra: 1 }],
      analysis: { hacked: true }, state: 'approved',
    }, analysis);
    expect(s).toEqual({
      cut: 'cut-20', scale: 1.5, x: 0.4, lead: 'Lead', emph: 'Big words', panels: false,
      trim_in: 30, trim_out: 600, preroll: false, card_title: 'A title',
      card_speakers: [{ name: 'Dex', role: null, company: 'HumanLayer' }],
    });
    expect('analysis' in s).toBe(false);
    expect('state' in s).toBe(false);
  });
  it('drops an unknown cut key and an inverted trim', () => {
    const s = sanitiseSelection({ cut: 'cut-99', trim_in: 500, trim_out: 100 }, analysis);
    expect(s.cut).toBeNull();
    expect(s.trim_in).toBeNull();
    expect(s.trim_out).toBeNull();
  });
  it('treats empty strings as no trim', () => {
    const s = sanitiseSelection({ trim_in: '', trim_out: '' }, analysis);
    expect(s.trim_in).toBeNull();
    expect(s.trim_out).toBeNull();
  });
});

describe('isStale', () => {
  it('treats a working row with no progress for two hours as abandoned, and never a finished one', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(isStale({ state: 'analysing', updated_at: '2026-10-16T11:30:00Z' }, now)).toBe(false);
    expect(isStale({ state: 'analysing', updated_at: '2026-10-16T09:00:00Z' }, now)).toBe(true);
    expect(isStale({ state: 'finalising', updated_at: null }, now)).toBe(true);
    expect(isStale({ state: 'ready', updated_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
  });
});

describe('cliUploadCommand', () => {
  it('builds a curl line with the declared type and a safe filename', () => {
    expect(cliUploadCommand('https://s3.example/x?sig=1', 'video/mp4', 'My Talk; rm -rf.mp4'))
      .toBe('curl -T "My Talk_ rm -rf.mp4" -H "Content-Type: video/mp4" "https://s3.example/x?sig=1"');
  });
});

type Handler = (req: unknown, res: unknown) => Promise<void>;

/** A minimal express-like router that records handlers. */
function fakeRouter() {
  const routes: Record<string, Handler> = {};
  return {
    routes,
    get: (p: string, h: Handler) => { routes[`GET ${p}`] = h; },
    post: (p: string, h: Handler) => { routes[`POST ${p}`] = h; },
    patch: (p: string, h: Handler) => { routes[`PATCH ${p}`] = h; },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null as unknown, status(c: number) { res.statusCode = c; return res; }, json(b: unknown) { res.body = b; return res; } };
  return res;
}

describe('mountStudioRoutes', () => {
  let from: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any;
  beforeEach(() => {
    from = vi.fn();
    supabase = { from, storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `http://media/${p}` } }) }) } };
  });

  it('refuses every route before touching the database when the caller may not edit the video', async () => {
    const router = fakeRouter();
    const denyUnlessVideo = vi.fn(async (_req, res) => { res.status(403).json({ error: 'nope' }); return true; });
    mountStudioRoutes(router as never, { supabase, denyUnlessVideo, callerId: async () => 'u1', logger: { info() {}, warn() {} }, enqueueJob: vi.fn() });
    for (const key of Object.keys(router.routes)) {
      const res = fakeRes();
      await router.routes[key]({ params: { videoId: '11111111-1111-4111-8111-111111111111' }, body: {} }, res);
      expect(res.statusCode, key).toBe(403);
    }
    expect(from).not.toHaveBeenCalled();
    expect(denyUnlessVideo).toHaveBeenCalledTimes(Object.keys(router.routes).length);
  });

  it('refuses to approve when the ready master is not the one analysed', async () => {
    const router = fakeRouter();
    const chain = (data: unknown) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'limit', 'update', 'insert']) c[m] = () => c;
      c.maybeSingle = async () => ({ data });
      c.single = async () => ({ data });
      return c;
    };
    from.mockImplementation((table: string) => {
      if (table === 'video_studio') return chain({ id: 's1', state: 'ready', analysis, master_asset_id: 'old-master' });
      if (table === 'video_assets') return chain({ id: 'new-master' });
      return chain(null);
    });
    const enqueueJob = vi.fn();
    mountStudioRoutes(router as never, { supabase, denyUnlessVideo: async () => false, callerId: async () => 'u1', logger: { info() {}, warn() {} }, enqueueJob });
    const res = fakeRes();
    await router.routes['POST /videos/:videoId/studio/approve']({ params: { videoId: '11111111-1111-4111-8111-111111111111' }, body: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a second trim or card once a cut master has been written', async () => {
    const router = fakeRouter();
    const chain = (data: unknown) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'limit', 'update', 'insert']) c[m] = () => c;
      c.maybeSingle = async () => ({ data });
      c.single = async () => ({ data });
      return c;
    };
    from.mockImplementation((table: string) => {
      if (table === 'video_studio') return chain({ id: 's1', state: 'approved', analysis, master_asset_id: 'cut-master', outputs: { master_asset_id: 'cut-master' }, updated_at: new Date().toISOString() });
      if (table === 'video_assets') return chain({ id: 'cut-master' });
      return chain(null);
    });
    const enqueueJob = vi.fn();
    mountStudioRoutes(router as never, { supabase, denyUnlessVideo: async () => false, callerId: async () => 'u1', logger: { info() {}, warn() {} }, enqueueJob });
    const res = fakeRes();
    await router.routes['POST /videos/:videoId/studio/approve']({ params: { videoId: '11111111-1111-4111-8111-111111111111' }, body: { selection: { preroll: true } } }, res);
    expect(res.statusCode).toBe(409);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses to start when FAL is not configured', async () => {
    const router = fakeRouter();
    const prev = process.env.FAL_API_KEY;
    delete process.env.FAL_API_KEY;
    try {
      mountStudioRoutes(router as never, { supabase, denyUnlessVideo: async () => false, callerId: async () => 'u1', logger: { info() {}, warn() {} }, enqueueJob: vi.fn() });
      const res = fakeRes();
      await router.routes['POST /videos/:videoId/studio']({ params: { videoId: '11111111-1111-4111-8111-111111111111' }, body: {} }, res);
      expect(res.statusCode).toBe(503);
      expect(from).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.FAL_API_KEY = prev;
    }
  });
});
