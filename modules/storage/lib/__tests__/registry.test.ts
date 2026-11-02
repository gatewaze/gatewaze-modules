import { describe, expect, it, vi } from 'vitest';
import { createStorageRegistry, StorageUnavailableError, type StorageClient } from '../registry.js';
import type { ObjectStore, StorageProviderModule } from '../types.js';

type Row = { id: string; status: string; config: Record<string, unknown> };

function client(rows: Row[]) {
  const reads: string[][] = [];
  const c = {
    storage: { from: () => ({}) },
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          reads.push(ids);
          return { data: rows.filter((r) => ids.includes(r.id)), error: null };
        },
      }),
    }),
  } as unknown as StorageClient;
  return { c, reads };
}

const fakeStore = (provider: string, bucket: string) => ({ provider, bucket }) as unknown as ObjectStore;

const fake: StorageProviderModule<{ bucket: string }> = {
  id: 'fake',
  settings: (env, cfg) => {
    const b = String(env.FAKE_BUCKET ?? cfg.FAKE_BUCKET ?? '');
    return b ? { bucket: b } : null;
  },
  defaultBucket: (s) => s.bucket,
  createStore: (_s, bucket) => fakeStore('fake', bucket),
};

const loadProvider = vi.fn(async (id: string) => {
  if (id === 'fake') return fake as StorageProviderModule;
  throw new StorageUnavailableError(`storage-${id} is not installed here`);
});

const ENABLED: Row = { id: 'storage-fake', status: 'enabled', config: { FAKE_BUCKET: 'fake-bucket' } };

describe('storeForNew', () => {
  it('uses Supabase when nothing is chosen', async () => {
    const { c } = client([]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    const s = await r.storeForNew();
    expect([s.provider, s.bucket]).toEqual(['supabase', 'media']);
  });

  it('uses the provider chosen in the storage module config', async () => {
    const { c } = client([{ id: 'storage', status: 'enabled', config: { default_provider: 'fake' } }, ENABLED]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    const s = await r.storeForNew();
    expect([s.provider, s.bucket]).toEqual(['fake', 'fake-bucket']);
  });

  it('lets the env choose, and a purpose override the default', async () => {
    const { c } = client([ENABLED]);
    const r = createStorageRegistry({ supabase: c, env: { STORAGE_PROVIDER: 'supabase', STORAGE_PROVIDER_MEDIA: 'fake' }, loadProvider });
    expect((await r.storeForNew({ purpose: 'media' })).provider).toBe('fake');
    expect((await r.storeForNew({ purpose: 'avatars' })).provider).toBe('supabase');
  });

  it('falls back to Supabase, and warns once, when the provider is not enabled', async () => {
    const { c } = client([{ ...ENABLED, status: 'disabled' }]);
    const logger = { warn: vi.fn() };
    const r = createStorageRegistry({ supabase: c, env: { STORAGE_PROVIDER: 'fake' }, loadProvider, logger });
    expect((await r.storeForNew()).provider).toBe('supabase');
    expect((await r.storeForNew()).provider).toBe('supabase');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to Supabase when the provider is not configured or not installed', async () => {
    const { c } = client([{ ...ENABLED, config: {} }, { id: 'storage-gone', status: 'enabled', config: {} }]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    const r2 = createStorageRegistry({ supabase: c, env: { STORAGE_PROVIDER: 'gone' }, loadProvider });
    expect((await createStorageRegistry({ supabase: c, env: { STORAGE_PROVIDER: 'fake' }, loadProvider }).storeForNew()).provider).toBe('supabase');
    expect((await r2.storeForNew()).provider).toBe('supabase');
    expect((await r.storeForNew()).provider).toBe('supabase');
  });

  it('never loads a provider whose id is not a plain name', async () => {
    const { c } = client([]);
    const load = vi.fn(async () => fake as StorageProviderModule);
    const r = createStorageRegistry({ supabase: c, env: { STORAGE_PROVIDER: '../../evil' }, loadProvider: load });
    expect((await r.storeForNew()).provider).toBe('supabase');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('storeFor', () => {
  it('reads Supabase rows from their own bucket, and old rows from the fallback', async () => {
    const { c } = client([]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    expect((await r.storeFor({ storage_provider: 'supabase', storage_bucket: 'video-masters' }, 'media', { supabaseBuckets: ['video-masters'] })).bucket).toBe('video-masters');
    expect((await r.storeFor({})).bucket).toBe('media');
    expect((await r.storeFor({ storage_bucket: null }, 'old-media')).bucket).toBe('old-media');
  });

  it('refuses a Supabase bucket the caller did not name', async () => {
    const { c } = client([]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    await expect(r.storeFor({ storage_provider: 'supabase', storage_bucket: 'video-masters' })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('reads a provider row from the bucket the row names, when the provider serves it', async () => {
    const { c } = client([ENABLED]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    const s = await r.storeFor({ storage_provider: 'fake', storage_bucket: 'fake-bucket' });
    expect([s.provider, s.bucket]).toEqual(['fake', 'fake-bucket']);
    await expect(r.storeFor({ storage_provider: 'fake', storage_bucket: 'someone-elses' })).rejects.toThrow('does not serve bucket');
  });

  it('fails rather than guessing when the row provider is unavailable', async () => {
    const { c } = client([{ ...ENABLED, status: 'disabled' }]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    await expect(r.storeFor({ storage_provider: 'fake', storage_bucket: 'fake-bucket' })).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(r.storeFor({ storage_provider: 'supabase', storage_bucket: 'Not A Bucket' })).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('reads module config once a minute, not once a call', async () => {
    let t = 0;
    const { c, reads } = client([ENABLED]);
    const r = createStorageRegistry({ supabase: c, env: {}, loadProvider, now: () => t });
    await r.storeFor({ storage_provider: 'fake', storage_bucket: 'fake-bucket' });
    await r.storeFor({ storage_provider: 'fake', storage_bucket: 'fake-bucket' });
    expect(reads).toHaveLength(1);
    t = 61_000;
    await r.storeFor({ storage_provider: 'fake', storage_bucket: 'fake-bucket' });
    expect(reads).toHaveLength(2);
  });
});

describe('delivery', () => {
  it('puts the Bunny zone in front of Supabase only when asked', async () => {
    const { c } = client([]);
    const env = { SUPABASE_URL: 'https://abc.supabase.co', BUNNY_CDN_ENABLED: 'true', BUNNY_PULLZONE_URL: 'https://zone.b-cdn.net' };
    const r = createStorageRegistry({ supabase: c, env, loadProvider });
    expect((await r.storeFor({})).publicUrl('a/b.jpg')).toBe('https://abc.supabase.co/storage/v1/object/public/media/a/b.jpg');
    expect((await r.storeFor({}, 'media', { cdn: true })).publicUrl('a/b.jpg')).toBe('https://zone.b-cdn.net/storage/v1/object/public/media/a/b.jpg');
    expect((await r.storeForNew({ cdn: true })).publicUrl('a/b.jpg')).toBe('https://zone.b-cdn.net/storage/v1/object/public/media/a/b.jpg');
  });
});
