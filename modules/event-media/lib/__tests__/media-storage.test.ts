// @ts-nocheck — vitest harness.
import { describe, it, expect, vi } from 'vitest';
import { createMediaStorage, builtInSupabaseStores } from '../media-storage.js';
import { browserObjectUrl, browserSizedUrl } from '../cdn.js';

const supabase = { storage: { from: () => ({
  upload: vi.fn(async () => ({ error: null })),
  remove: vi.fn(async () => ({ error: null })),
  createSignedUrl: vi.fn(async (p) => ({ data: { signedUrl: `http://kong:8000/sign/${p}` }, error: null })),
  createSignedUploadUrl: vi.fn(async (p) => ({ data: { signedUrl: `http://kong:8000/upload/${p}?token=t` }, error: null })),
}) } };
const ZONE = { zone: 'https://zone.b-cdn.net' };
const PUB = 'https://abc.supabase.co';
const builtIn = builtInSupabaseStores({ supabase, bucket: 'media', publicSupabaseUrl: PUB, internalSupabaseUrl: 'http://kong:8000', cdn: ZONE });

describe('the built-in Supabase stores', () => {
  it('build the addresses lib/cdn.ts always built: the CDN for browsers, direct for models', () => {
    const p = 'event/e/m/a.jpg';
    expect(builtIn.browser.publicUrl(p)).toBe(browserObjectUrl(ZONE, PUB, 'media', p));
    expect(builtIn.browser.sizedUrl(p, { width: 350 })).toBe(browserSizedUrl(ZONE, PUB, 'media', p, 350));
    expect(builtIn.direct.publicUrl(p)).toBe(browserObjectUrl({ zone: null }, PUB, 'media', p));
  });

  it('hand out upload addresses a browser can reach', async () => {
    const up = await builtIn.direct.signUpload('event/e/m/a.jpg', { contentType: 'image/jpeg' });
    expect(up).toEqual({ url: `${PUB}/upload/event/e/m/a.jpg?token=t`, method: 'PUT', headers: { 'content-type': 'image/jpeg' } });
  });
});

describe('createMediaStorage', () => {
  it('without the storage module, serves Supabase rows and refuses any other', async () => {
    const m = createMediaStorage({ registry: null, fallback: builtIn, bucket: 'media', logger: { warn: () => {} } });
    expect(await m.forRow({})).toBe(builtIn);
    expect(await m.forRow({ storage_provider: 'supabase', storage_bucket: 'media' })).toBe(builtIn);
    await expect(m.forRow({ storage_provider: 'r2', storage_bucket: 'b-1' })).rejects.toThrow('needs the storage module');
    await expect(m.forRow({ storage_bucket: 'other' })).rejects.toThrow('needs the storage module');
    expect(await m.forNew()).toBe(builtIn);
  });

  it('asks the registry for the CDN store and the direct one', async () => {
    const calls = [];
    const registry = {
      storeForNew: async (o) => { calls.push(['new', o]); return { provider: 'r2', bucket: 'b-1', cdn: o.cdn }; },
      storeFor: async (row, fb, o) => { calls.push(['row', row, fb, o]); return { provider: row.storage_provider ?? 'supabase', bucket: row.storage_bucket ?? fb, cdn: o.cdn }; },
    };
    const m = createMediaStorage({ registry, fallback: builtIn, bucket: 'media', logger: { warn: () => {} } });
    const s = await m.forRow({ storage_provider: 'r2', storage_bucket: 'b-1' });
    expect([s.browser.cdn, s.direct.cdn]).toEqual([true, false]);
    const n = await m.forNew();
    expect(calls.filter((c) => c[0] === 'new').map((c) => c[1])).toEqual([
      { purpose: 'media', supabaseBucket: 'media', cdn: true },
      { purpose: 'media', supabaseBucket: 'media', cdn: false },
    ]);
    expect(m.columnsFor(n.direct)).toEqual({ storage_provider: 'r2', storage_bucket: 'b-1' });
    expect(m.columnsFor({ provider: 'supabase', bucket: 'media' })).toEqual({});
  });

  it('looks each location up once for a page, and leaves out rows it cannot serve', async () => {
    let lookups = 0;
    const registry = {
      storeForNew: async () => { throw new Error('unused'); },
      storeFor: async (row) => { lookups += 1; if (row.storage_provider === 'gone') throw new Error('off'); return { provider: row.storage_provider ?? 'supabase' }; },
    };
    const warn = vi.fn();
    const m = createMediaStorage({ registry, fallback: builtIn, bucket: 'media', logger: { warn } });
    const of = await m.forRows([{}, {}, { storage_provider: 'gone' }, {}]);
    expect(of({})).not.toBeNull();
    expect(of({ storage_provider: 'gone' })).toBeNull();
    expect(lookups).toBe(4); // two locations x (cdn, direct)
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
