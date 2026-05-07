// @ts-nocheck — vitest harness; route handlers are @ts-nocheck'd already.

import { describe, it, expect, beforeEach } from 'vitest';
import { createMediaRoutes } from '../routes.js';
import { _resetRegistryForTests, registerHostMediaConsumer } from '../../lib/registry.js';

const SITE_ID = '7ffd554a-21d1-452d-a3ec-bcf952fb1652';
const MEDIA_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockRes() {
  const res: { statusCode: number; body: unknown; headers: Record<string, string>; status: (s: number) => typeof res; json: (b: unknown) => typeof res; setHeader: (k: string, v: string) => typeof res; end: () => typeof res; write: (chunk: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(s) { res.statusCode = s; return res; },
    json(b) { res.body = b; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
    end() { return res; },
    write(_chunk) { return res; },
  };
  return res;
}

function mockSupabase(overrides: Record<string, unknown> = {}) {
  const calls: { table?: string; rpc?: string; args?: unknown }[] = [];

  const queryBuilder = (data: unknown = null, error: unknown = null) => {
    const fns = {
      data, error,
      select: () => fns,
      eq: () => fns,
      neq: () => fns,
      lte: () => fns,
      lt: () => fns,
      gte: () => fns,
      in: () => fns,
      ilike: () => fns,
      like: () => fns,
      or: () => fns,
      order: () => fns,
      limit: () => fns,
      maybeSingle: () => Promise.resolve({ data, error }),
      single: () => Promise.resolve({ data, error }),
      then: (cb: (r: { data: unknown; error: unknown }) => unknown) => cb({ data, error }),
    };
    return fns;
  };

  return {
    calls,
    from(table: string) {
      calls.push({ table });
      const tableData = (overrides as Record<string, unknown>)[`from:${table}`] ?? [];
      const tableErr = (overrides as Record<string, unknown>)[`from-err:${table}`] ?? null;
      return {
        ...queryBuilder(tableData, tableErr),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: tableData, error: tableErr }) }) }),
        update: () => queryBuilder(tableData, tableErr),
        delete: () => queryBuilder(tableData, tableErr),
      };
    },
    rpc(name: string, args: unknown) {
      calls.push({ rpc: name, args });
      const rpcData = (overrides as Record<string, unknown>)[`rpc:${name}`];
      return Promise.resolve({ data: rpcData ?? null, error: null });
    },
  };
}

function makeDeps(supabaseOverrides: Record<string, unknown> = {}) {
  return {
    supabase: mockSupabase(supabaseOverrides),
    mediaAdapter: {
      upload: async (args: { mediaId: string }) => ({
        storagePath: `path/${args.mediaId}/file.jpg`,
        cdnUrl: `https://cdn.example/${args.mediaId}/file.jpg`,
      }),
      delete: async () => undefined,
      getPublicUrl: (path: string) => `https://cdn.example/${path}`,
      createSignedUrl: async () => 'https://signed.example/url',
    },
    parseUploadedFiles: async () => [],
    rateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe('host-media routes', () => {
  beforeEach(() => {
    _resetRegistryForTests();
    registerHostMediaConsumer({ hostKind: 'site', enableAlbums: false, enableYouTube: false, enableZipUnpack: false });
    registerHostMediaConsumer({ hostKind: 'event', enableAlbums: true, enableYouTube: true, enableZipUnpack: true });
  });

  describe('listMedia', () => {
    it('returns 400 for unknown host_kind', async () => {
      const routes = createMediaRoutes(makeDeps());
      const req = { params: { hostKind: 'rogue', hostId: SITE_ID }, query: {} } as never;
      const res = mockRes();
      await routes.listMedia(req, res as never);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_host_kind');
    });

    it('returns 400 for non-UUID host_id', async () => {
      const routes = createMediaRoutes(makeDeps());
      const req = { params: { hostKind: 'site', hostId: 'not-a-uuid' }, query: {} } as never;
      const res = mockRes();
      await routes.listMedia(req, res as never);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_host_id');
    });

    it('returns 200 with empty list for known kind + valid id', async () => {
      const routes = createMediaRoutes(makeDeps({ 'from:host_media': [] }));
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {} } as never;
      const res = mockRes();
      await routes.listMedia(req, res as never);
      expect(res.statusCode).toBe(200);
      expect((res.body as { items: unknown[] }).items).toEqual([]);
    });
  });

  describe('uploadMedia', () => {
    it('returns 401 without userId', async () => {
      const routes = createMediaRoutes(makeDeps());
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {} } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 no_files when nothing uploaded', async () => {
      const routes = createMediaRoutes(makeDeps());
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {}, userId: USER_ID } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe('no_files');
    });

    it('returns 429 + Retry-After when rate-limited', async () => {
      const deps = makeDeps();
      deps.rateLimit = async () => ({ allowed: false, resetAt: Date.now() + 30_000 });
      const routes = createMediaRoutes(deps);
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {}, userId: USER_ID } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBeDefined();
    });

    it('rejects unsupported MIME with per-file failed status (415-equivalent in batch)', async () => {
      const deps = makeDeps({ 'rpc:host_media_quota_check': { ok: true } });
      deps.parseUploadedFiles = async () => [{
        filename: 'evil.exe',
        mimeType: 'application/x-msdownload',
        bytes: 100,
        buffer: Buffer.from(''),
      }];
      const routes = createMediaRoutes(deps);
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {}, userId: USER_ID } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(207);
      const item = (res.body as { items: Array<{ status: string; error: string }> }).items[0];
      expect(item.status).toBe('failed');
      expect(item.error).toBe('unsupported_media_type');
    });

    it('rejects zip when consumer.enableZipUnpack=false', async () => {
      const deps = makeDeps({ 'rpc:host_media_quota_check': { ok: true } });
      deps.parseUploadedFiles = async () => [{
        filename: 'photos.zip',
        mimeType: 'application/zip',
        bytes: 100,
        buffer: Buffer.from(''),
      }];
      const routes = createMediaRoutes(deps);
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {}, userId: USER_ID } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(207);
      const item = (res.body as { items: Array<{ status: string; error: string }> }).items[0];
      expect(item.error).toBe('zip_not_enabled');
    });

    it('rejects when quota_check.ok=false', async () => {
      const deps = makeDeps({ 'rpc:host_media_quota_check': { ok: false } });
      deps.parseUploadedFiles = async () => [{
        filename: 'big.jpg',
        mimeType: 'image/jpeg',
        bytes: 10_000_000_000,
        buffer: Buffer.from(''),
      }];
      const routes = createMediaRoutes(deps);
      const req = { params: { hostKind: 'site', hostId: SITE_ID }, query: {}, body: {}, userId: USER_ID } as never;
      const res = mockRes();
      await routes.uploadMedia(req, res as never);
      expect(res.statusCode).toBe(207);
      const item = (res.body as { items: Array<{ status: string; error: string }> }).items[0];
      expect(item.error).toBe('quota_exceeded');
    });
  });

  describe('patchMedia', () => {
    it('rejects when no allowlisted fields present (mass-assignment defense)', async () => {
      const routes = createMediaRoutes(makeDeps());
      const req = {
        params: { hostKind: 'site', hostId: SITE_ID, id: MEDIA_ID },
        body: { host_id: 'evil', secret: 'leak', is_approved: true },
        userId: USER_ID,
      } as never;
      const res = mockRes();
      await routes.patchMedia(req, res as never);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe('no_fields');
    });
  });

  describe('deleteMedia', () => {
    it('refuses delete when used_in.length > 0', async () => {
      const routes = createMediaRoutes(makeDeps({
        'from:host_media': { id: MEDIA_ID, storage_path: 'p', bytes: 100, used_in: [{ type: 'page', id: 'x', name: 'About' }] },
      }));
      const req = { params: { hostKind: 'site', hostId: SITE_ID, id: MEDIA_ID }, userId: USER_ID } as never;
      const res = mockRes();
      await routes.deleteMedia(req, res as never);
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: string }).error).toBe('media_in_use');
    });
  });
});
