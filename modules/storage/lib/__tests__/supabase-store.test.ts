import { describe, expect, it, vi } from 'vitest';
import { assertSafeKey, assertFolderPrefix, encodeKey, versionParam } from '../keys.js';
import { supabaseSettingsFromEnv, supabaseStore, externalise, type SupabaseStorageClient } from '../supabase-store.js';
import { browserObjectUrl, browserSizedUrl, cdnConfigFromEnv } from '../../../event-media/lib/cdn.js';

const ENV = { SUPABASE_URL: 'http://supabase-kong:8000', SUPABASE_PUBLIC_URL: 'https://abc.supabase.co' };

function fakeClient(over: Partial<ReturnType<SupabaseStorageClient['storage']['from']>> = {}) {
  const bucket = {
    upload: vi.fn(async () => ({ error: null })),
    remove: vi.fn(async () => ({ error: null })),
    createSignedUrl: vi.fn(async (p: string) => ({ data: { signedUrl: `http://supabase-kong:8000/storage/v1/object/sign/media/${p}?token=t` }, error: null })),
    createSignedUploadUrl: vi.fn(async (p: string) => ({ data: { signedUrl: `http://supabase-kong:8000/storage/v1/object/upload/sign/media/${p}?token=u` }, error: null })),
    list: vi.fn(async () => ({ data: [], error: null })),
    copy: vi.fn(async () => ({ error: null })),
    ...over,
  };
  return { client: { storage: { from: vi.fn(() => bucket) } } as unknown as SupabaseStorageClient, bucket };
}

describe('keys', () => {
  it('refuses keys that could escape their prefix', () => {
    for (const bad of ['', '/abs', 'a/../b', 'a\\b', 'a\nb', 'a\x00b', 'a?x=1', 'a#b', 'x'.repeat(1025)]) {
      expect(() => assertSafeKey(bad)).toThrow('unsafe storage path');
    }
    expect(assertSafeKey('event/1/2/photo.jpg')).toBe('event/1/2/photo.jpg');
  });

  it('wants listing prefixes to end in a slash', () => {
    expect(() => assertFolderPrefix('event/1')).toThrow();
    expect(assertFolderPrefix('event/1/')).toBe('event/1/');
  });

  it('encodes each segment and keeps the slashes', () => {
    expect(encodeKey('event/a b/ü.jpg')).toBe('event/a%20b/%C3%BC.jpg');
  });

  it('adds a version only when there is one', () => {
    expect(versionParam(null, '?')).toBe('');
    expect(versionParam('', '&')).toBe('');
    expect(versionParam('2026-11-01T10:00:00Z', '?')).toBe('?v=2026-11-01T10%3A00%3A00Z');
  });
});

describe('supabase store addresses', () => {
  it('builds the same plain and resized addresses as event-media did by hand', () => {
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    const path = 'event/e1/m1/photo.jpg';
    const cfg = cdnConfigFromEnv({});
    expect(store.publicUrl(path)).toBe(browserObjectUrl(cfg, 'https://abc.supabase.co', 'media', path));
    expect(store.sizedUrl(path, { width: 640, quality: 75 })).toBe(browserSizedUrl(cfg, 'https://abc.supabase.co', 'media', path, 640, 75));
  });

  it('builds the same Bunny addresses as event-media did by hand', () => {
    const env = { ...ENV, BUNNY_CDN_ENABLED: 'true', BUNNY_PULLZONE_URL: 'https://zone.b-cdn.net/' };
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(env), 'media');
    const path = 'event/e1/m1/photo.jpg';
    const cfg = cdnConfigFromEnv(env);
    expect(store.publicUrl(path)).toBe(browserObjectUrl(cfg, 'https://abc.supabase.co', 'media', path));
    expect(store.sizedUrl(path, { width: 350 })).toBe(browserSizedUrl(cfg, 'https://abc.supabase.co', 'media', path, 350));
  });

  it('ignores a Bunny zone that is not a plain https host', () => {
    const s = supabaseSettingsFromEnv({ ...ENV, BUNNY_CDN_ENABLED: 'true', BUNNY_PULLZONE_URL: 'http://zone.b-cdn.net' });
    expect(s.bunnyZone).toBeNull();
  });

  it('returns the original when Supabase resizing is off and there is no zone', () => {
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv({ ...ENV, STORAGE_SUPABASE_RESIZE: 'false' }), 'media');
    expect(store.canResize).toBe(false);
    expect(store.sizedUrl('a/b.jpg', { width: 100 })).toBe('https://abc.supabase.co/storage/v1/object/public/media/a/b.jpg');
  });

  it('adds the version to both kinds of address', () => {
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    expect(store.publicUrl('a/b.jpg', { version: 3 })).toMatch(/\?v=3$/);
    expect(store.sizedUrl('a/b.jpg', { width: 100 }, { version: 3 })).toMatch(/&v=3$/);
  });

  it('turns in-cluster signed addresses into public ones', async () => {
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    const up = await store.signUpload('a/b.jpg', { contentType: 'image/jpeg' });
    expect(up.url.startsWith('https://abc.supabase.co/storage/v1/object/upload/sign/media/a/b.jpg')).toBe(true);
    expect(up.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(await store.signRead('a/b.jpg', 60)).toMatch(/^https:\/\/abc\.supabase\.co\//);
    expect(externalise('http://other/x', supabaseSettingsFromEnv(ENV))).toBe('http://other/x');
  });
});

describe('supabase store writes', () => {
  it('does not overwrite unless asked', async () => {
    const { client, bucket } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    await store.put('a/b.jpg', Buffer.from('xx'), { contentType: 'image/jpeg' });
    expect(bucket.upload).toHaveBeenLastCalledWith('a/b.jpg', expect.anything(), expect.objectContaining({ upsert: false }));
    await store.put('a/b.jpg', Buffer.from('xx'), { contentType: 'image/jpeg', upsert: true });
    expect(bucket.upload).toHaveBeenLastCalledWith('a/b.jpg', expect.anything(), expect.objectContaining({ upsert: true }));
  });

  it('gives supabase-js the cache time in seconds, as it expects', async () => {
    const { client, bucket } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    await store.put('a/b.jpg', Buffer.from('x'), { contentType: 'image/jpeg' });
    expect(bucket.upload).toHaveBeenLastCalledWith('a/b.jpg', expect.anything(), expect.objectContaining({ cacheControl: '31536000' }));
    await store.put('a/b.jpg', Buffer.from('x'), { contentType: 'image/jpeg', upsert: true });
    expect(bucket.upload).toHaveBeenLastCalledWith('a/b.jpg', expect.anything(), expect.objectContaining({ cacheControl: '3600' }));
    await store.put('a/b.jpg', Buffer.from('x'), { contentType: 'image/jpeg', cacheControl: 'public, max-age=60' });
    expect(bucket.upload).toHaveBeenLastCalledWith('a/b.jpg', expect.anything(), expect.objectContaining({ cacheControl: '60' }));
  });

  it('signs reads for the server without rewriting the address', async () => {
    const { client } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    expect(await store.signRead('a/b.jpg', 60, { forServer: true })).toMatch(/^http:\/\/supabase-kong:8000\//);
  });

  it('refuses a buffer over the limit before uploading', async () => {
    const { client, bucket } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    await expect(store.put('a/b.jpg', Buffer.alloc(10), { contentType: 'image/jpeg', maxBytes: 5 })).rejects.toThrow('size limit');
    expect(bucket.upload).not.toHaveBeenCalled();
  });

  it('reports unsafe and failed paths from remove without throwing', async () => {
    const { client, bucket } = fakeClient({ remove: vi.fn(async () => ({ error: { message: 'boom' } })) });
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    const r = await store.remove(['../x', 'a/b.jpg']);
    expect(r.failed.sort()).toEqual(['../x', 'a/b.jpg']);
    expect(bucket.remove).toHaveBeenCalledWith(['a/b.jpg']);
  });

  it('removes in batches of 1,000', async () => {
    const { client, bucket } = fakeClient();
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    const paths = Array.from({ length: 2001 }, (_, i) => `a/${i}.jpg`);
    expect((await store.remove(paths)).failed).toEqual([]);
    expect(bucket.remove).toHaveBeenCalledTimes(3);
  });

  it('walks folders when listing', async () => {
    const list = vi.fn(async (dir: string) => {
      if (dir === 'event/e1') return { data: [{ name: 'm1', id: null }, { name: 'x.jpg', id: '1', metadata: { size: 5 } }], error: null };
      if (dir === 'event/e1/m1') return { data: [{ name: 'y.jpg', id: '2', metadata: { size: 7 } }], error: null };
      return { data: [], error: null };
    });
    const { client } = fakeClient({ list });
    const store = supabaseStore(client, supabaseSettingsFromEnv(ENV), 'media');
    expect(await store.list('event/e1/')).toEqual([
      { path: 'event/e1/x.jpg', bytes: 5 },
      { path: 'event/e1/m1/y.jpg', bytes: 7 },
    ]);
  });
});
