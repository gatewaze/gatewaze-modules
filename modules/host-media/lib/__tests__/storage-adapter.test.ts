import { describe, expect, it, vi } from 'vitest';
import { createStorageMediaAdapter, lazyMediaAdapter, supabaseOnly, registryCandidates, type Registry } from '../storage-adapter.js';
import { createStorageRegistry } from '../../../storage/lib/registry.js';
import type { MediaAdapter } from '../../api/routes.js';

function fakeStore(provider: string, bucket: string) {
  return {
    provider,
    bucket,
    publicUrl: (p: string) => `https://${provider}.example/${bucket}/${p}`,
    sizedUrl: (p: string, s: { width: number }) => `https://${provider}.example/${bucket}/${p}?w=${s.width}`,
    put: vi.fn(async (_p: string, b: Buffer) => ({ bytes: b.byteLength })),
    signRead: vi.fn(async (p: string, ttl: number, o?: { forServer?: boolean }) => `https://${provider}.example/signed/${p}?ttl=${ttl}&server=${Boolean(o?.forServer)}`),
    remove: vi.fn(async () => ({ failed: [] as string[] })),
  };
}

function fakeRegistry(newStore = fakeStore('r2', 'aime-media')) {
  const stores = new Map<string, ReturnType<typeof fakeStore>>();
  const registry: Registry = {
    storeForNew: vi.fn(async () => newStore),
    storeFor: vi.fn(async (row, fallback) => {
      const key = `${row.storage_provider || 'supabase'}/${row.storage_bucket || fallback}`;
      if (!stores.has(key)) stores.set(key, fakeStore(row.storage_provider || 'supabase', row.storage_bucket || fallback));
      return stores.get(key)!;
    }),
  };
  return { registry, newStore, stores };
}

describe('createStorageMediaAdapter', () => {
  it('uploads to the store chosen for new media and says where it went', async () => {
    const { registry, newStore } = fakeRegistry();
    const a = createStorageMediaAdapter(registry);
    const out = await a.upload({ hostKind: 'event', hostId: 'h1', mediaId: 'm1', filename: 'My Photo.JPG', mimeType: 'image/jpeg', buffer: Buffer.from('x') });
    expect(out).toEqual({
      storagePath: 'event/h1/m1/my-photo.jpg',
      cdnUrl: 'https://r2.example/aime-media/event/h1/m1/my-photo.jpg',
      storageProvider: 'r2',
      storageBucket: 'aime-media',
    });
    expect(registry.storeForNew).toHaveBeenCalledWith({ purpose: 'media', supabaseBucket: 'media' });
    expect(newStore.put).toHaveBeenCalledWith('event/h1/m1/my-photo.jpg', expect.any(Buffer), { contentType: 'image/jpeg', upsert: false });
  });

  it('leaves the location unset for files in its own Supabase bucket', async () => {
    const { registry } = fakeRegistry(fakeStore('supabase', 'media'));
    const out = await createStorageMediaAdapter(registry).upload({ hostKind: 'event', hostId: 'h1', mediaId: 'm1', filename: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') });
    expect(out).toEqual({ storagePath: 'event/h1/m1/a.jpg', cdnUrl: 'https://supabase.example/media/event/h1/m1/a.jpg' });
  });

  it('reads, signs and deletes in the store the row names', async () => {
    const { registry, stores } = fakeRegistry();
    const a = createStorageMediaAdapter(registry);
    const loc = { storage_provider: 'r2', storage_bucket: 'old-bucket' };
    expect(await a.getPublicUrl('p/a.jpg', loc)).toBe('https://r2.example/old-bucket/p/a.jpg');
    expect(await a.getRenderUrl!('p/a.jpg', 350, loc)).toBe('https://r2.example/old-bucket/p/a.jpg?w=350');
    expect(await a.createSignedUrl('p/a.jpg', 60, loc, { forServer: true })).toBe('https://r2.example/signed/p/a.jpg?ttl=60&server=true');
    await a.delete('p/a.jpg', loc);
    expect(stores.get('r2/old-bucket')!.remove).toHaveBeenCalledWith(['p/a.jpg']);
  });

  it('treats a row with no location as Supabase media', async () => {
    const { registry } = fakeRegistry();
    const a = createStorageMediaAdapter(registry);
    expect(await a.getPublicUrl('p/a.jpg')).toBe('https://supabase.example/media/p/a.jpg');
  });

  it('fails a delete the store could not do', async () => {
    const { registry, stores } = fakeRegistry();
    const a = createStorageMediaAdapter(registry);
    await a.getPublicUrl('x', {});
    stores.get('supabase/media')!.remove.mockResolvedValueOnce({ failed: ['p/a.jpg'] });
    await expect(a.delete('p/a.jpg', {})).rejects.toThrow('storage delete failed');
  });
});

describe('the built-in fallback', () => {
  const builtIn: MediaAdapter = {
    upload: async () => ({ storagePath: 'p', cdnUrl: 'u' }),
    delete: vi.fn(async () => undefined),
    getPublicUrl: (p: string) => `https://supabase.example/media/${p}`,
    createSignedUrl: async () => 'signed',
  };

  it('is used when the storage module cannot be loaded', async () => {
    const a = lazyMediaAdapter(async () => null, builtIn);
    expect(await a.getPublicUrl('p/a.jpg', { storage_provider: 'supabase', storage_bucket: 'media' })).toBe('https://supabase.example/media/p/a.jpg');
    const b = lazyMediaAdapter(async () => { throw new Error('nope'); }, builtIn);
    expect(await b.getPublicUrl('p/a.jpg')).toBe('https://supabase.example/media/p/a.jpg');
  });

  it('refuses rows kept anywhere but its own Supabase bucket', async () => {
    const a = supabaseOnly(builtIn, 'media');
    await expect(a.getPublicUrl('p/a.jpg', { storage_provider: 'r2', storage_bucket: 'aime-media' })).rejects.toThrow('needs the storage module');
    await expect(a.delete('p/a.jpg', { storage_provider: 'supabase', storage_bucket: 'other' })).rejects.toThrow('needs the storage module');
    expect(builtIn.delete).not.toHaveBeenCalled();
  });

  it('is not used when the storage module loads', async () => {
    const { registry } = fakeRegistry();
    const a = lazyMediaAdapter(async () => createStorageMediaAdapter(registry), builtIn);
    expect(await a.getPublicUrl('p/a.jpg', { storage_provider: 'r2', storage_bucket: 'b-1' })).toBe('https://r2.example/b-1/p/a.jpg');
  });
});

describe('with the real storage registry', () => {
  it('finds the storage module beside host-media', () => {
    expect(registryCandidates().some((c) => /modules\/storage\/lib\/registry\.(ts|js)$/.test(c))).toBe(true);
  });

  it('gives Supabase rows the same addresses the built-in adapter did', async () => {
    const supabase = {
      storage: { from: () => ({}) },
      from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
    };
    const env = { SUPABASE_URL: 'http://kong:8000', SUPABASE_PUBLIC_URL: 'https://abc.supabase.co', BUNNY_CDN_ENABLED: 'true', BUNNY_PULLZONE_URL: 'https://zone.b-cdn.net' };
    const registry = createStorageRegistry({ supabase: supabase as never, env });
    const a = createStorageMediaAdapter(registry as unknown as Registry);
    // Never through Bunny: host-media addresses end up in sent email.
    expect(await a.getPublicUrl('event/h/m/a.jpg', {})).toBe('https://abc.supabase.co/storage/v1/object/public/media/event/h/m/a.jpg');
    expect(await a.getRenderUrl!('event/h/m/a.jpg', 350, {})).toBe(
      'https://abc.supabase.co/storage/v1/render/image/public/media/event/h/m/a.jpg?width=350&resize=contain&quality=80',
    );
  });
});
