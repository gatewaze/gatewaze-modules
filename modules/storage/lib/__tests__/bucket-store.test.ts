import { afterEach, describe, expect, it, vi } from 'vitest';
import { aliasedBucketStore, downloadObject, setSharedStorageRegistry, sharedStorageRegistry } from '../bucket-store.js';
import { createStorageRegistry, type StorageClient } from '../registry.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../testing.js';

function client(config: Record<string, unknown>) {
  return {
    storage: { from: () => ({}) },
    from: () => ({
      select: () => ({
        in: async () => ({ data: [{ id: 'storage', status: 'enabled', config }], error: null }),
      }),
    }),
  } as unknown as StorageClient;
}

afterEach(() => {
  setSharedStorageRegistry(null);
  vi.unstubAllGlobals();
});

describe('aliasedBucketStore', () => {
  it('is null for a brand still on Supabase, using a real registry', async () => {
    setSharedStorageRegistry(createStorageRegistry({ supabase: client({}), env: { SUPABASE_URL: 'https://p.supabase.co' } }));
    expect(await aliasedBucketStore(null, 'media')).toBeNull();
    expect(await aliasedBucketStore(null, 'invite-templates')).toBeNull();
  });

  it('is null with the no-alias test registry', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    expect(await aliasedBucketStore(null, 'media')).toBeNull();
  });

  it('is the prefixed provider store when the alias is set', async () => {
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = await aliasedBucketStore(null, 'downloads');
    expect(s?.publicUrl('a.pdf')).toBe('https://media.test/downloads/a.pdf');
    await s!.put('a.pdf', Buffer.from('x'), { contentType: 'application/pdf' });
    expect(t.calls[0]).toMatchObject({ op: 'put', key: 'downloads/a.pdf' });
  });

  it('throws when the alias provider is unavailable', async () => {
    setSharedStorageRegistry(createStorageRegistry({
      supabase: client({ supabase_alias: 'r2' }),
      env: {},
      loadProvider: async () => { throw new Error('storage-r2 is not installed here'); },
    }));
    await expect(aliasedBucketStore(null, 'media')).rejects.toThrow();
  });

  it('creates one registry per process', () => {
    const a = sharedStorageRegistry(client({}));
    const b = sharedStorageRegistry(client({ supabase_alias: 'r2' }));
    expect(a).toBe(b);
  });
});

describe('downloadObject', () => {
  it('reads through a signed address', async () => {
    const t = aliasedTestRegistry();
    const store = await t.registry.bucketStore('video-masters');
    const fetchMock = vi.fn(async () => new Response('hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await downloadObject(store, 'v/1.mp4')).toString()).toBe('hello');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://s3.test/video-masters/v/1.mp4?sig');
  });

  it('refuses an object over the limit', async () => {
    const t = aliasedTestRegistry();
    const store = await t.registry.bucketStore('media');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('0123456789', { status: 200 })));
    await expect(downloadObject(store, 'a', { maxBytes: 4 })).rejects.toThrow('size limit');
  });

  it('fails on a non-2xx', async () => {
    const t = aliasedTestRegistry();
    const store = await t.registry.bucketStore('media');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(downloadObject(store, 'a')).rejects.toThrow('404');
  });
});
