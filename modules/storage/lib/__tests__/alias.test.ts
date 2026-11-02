import { describe, expect, it, vi } from 'vitest';
import { createStorageRegistry, StorageUnavailableError, type StorageClient } from '../registry.js';
import { prefixedStore } from '../prefixed-store.js';
import type { ObjectStore, StorageProviderModule } from '../types.js';

type Row = { id: string; status: string; config: Record<string, unknown> };

function client(rows: Row[]) {
  return {
    storage: { from: () => ({}) },
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }),
      }),
    }),
  } as unknown as StorageClient;
}

/** A store that records the keys it was given. */
function recordingStore(provider: string, bucket: string) {
  const calls: Array<[string, unknown]> = [];
  const store: ObjectStore = {
    provider,
    bucket,
    canResize: true,
    publicUrl: (p) => `https://pub.example/${p}`,
    sizedUrl: (p, s) => `https://pub.example/cdn-cgi/image/width=${s.width}/${p}`,
    put: async (p, b) => (calls.push(['put', p]), { bytes: (b as Buffer).length }),
    signUpload: async (p) => (calls.push(['signUpload', p]), { url: `https://s3.example/${p}`, method: 'PUT' as const, headers: {} }),
    signRead: async (p) => `https://s3.example/${p}?sig`,
    head: async (p) => (calls.push(['head', p]), { ok: true, bytes: 1, contentType: 'image/png' }),
    remove: async (ps) => (calls.push(['remove', ps]), { failed: ps.filter((x) => x.endsWith('bad.png')) }),
    list: async (prefix) => [{ path: `${prefix}a.png`, bytes: 1 }],
    copy: async (a, b) => void calls.push(['copy', [a, b]]),
    readRange: async (p) => (calls.push(['readRange', p]), Buffer.from('x')),
  };
  return { store, calls };
}

const r2 = recordingStore('r2', 'brand-media');
const fakeR2: StorageProviderModule<{ bucket: string }> = {
  id: 'r2',
  settings: (_env, cfg) => (cfg.R2_BUCKET ? { bucket: String(cfg.R2_BUCKET) } : null),
  defaultBucket: (s) => s.bucket,
  createStore: () => r2.store,
};
const loadProvider = vi.fn(async (id: string) => {
  if (id === 'r2') return fakeR2 as StorageProviderModule;
  throw new StorageUnavailableError(`storage-${id} is not installed here`);
});
const R2_ROW: Row = { id: 'storage-r2', status: 'enabled', config: { R2_BUCKET: 'brand-media' } };

describe('prefixedStore', () => {
  it('keeps the Supabase names and puts other buckets under their own folder', async () => {
    const { store, calls } = recordingStore('r2', 'brand-media');
    const s = prefixedStore(store, 'invite-templates');
    expect([s.provider, s.bucket]).toEqual(['supabase', 'invite-templates']);
    expect(s.publicUrl('e1/bg.pdf')).toBe('https://pub.example/invite-templates/e1/bg.pdf');
    await s.put('e1/bg.pdf', Buffer.from('x'), { contentType: 'application/pdf' });
    await s.copy('a.png', 'b.png');
    expect(calls).toContainEqual(['put', 'invite-templates/e1/bg.pdf']);
    expect(calls).toContainEqual(['copy', ['invite-templates/a.png', 'invite-templates/b.png']]);
  });

  it('leaves media at the root', () => {
    const { store } = recordingStore('r2', 'brand-media');
    expect(prefixedStore(store, 'media').publicUrl('event/x.jpg')).toBe('https://pub.example/event/x.jpg');
  });

  it('gives back paths without the prefix', async () => {
    const { store } = recordingStore('r2', 'brand-media');
    const s = prefixedStore(store, 'downloads');
    expect(await s.list('offers/')).toEqual([{ path: 'offers/a.png', bytes: 1 }]);
    expect(await s.remove(['ok.png', 'bad.png'])).toEqual({ failed: ['bad.png'] });
  });
});

describe('supabase_alias', () => {
  it('serves every Supabase bucket from the provider when set', async () => {
    const c = client([{ id: 'storage', status: 'enabled', config: { supabase_alias: 'r2' } }, R2_ROW]);
    const reg = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    const s = await reg.bucketStore('event-content-images');
    expect([s.provider, s.bucket]).toEqual(['supabase', 'event-content-images']);
    expect(s.publicUrl('e/1.png')).toBe('https://pub.example/event-content-images/e/1.png');
    // Rows that still say Supabase reach the same files.
    const row = await reg.storeFor({ storage_provider: 'supabase', storage_bucket: null }, 'media');
    expect(row.publicUrl('event/a.jpg')).toBe('https://pub.example/event/a.jpg');
    // So do new files when no provider is chosen for them.
    expect((await reg.storeForNew({ supabaseBucket: 'invite-templates' })).publicUrl('x.png')).toBe('https://pub.example/invite-templates/x.png');
  });

  it('changes nothing for a brand without it', async () => {
    const reg = createStorageRegistry({ supabase: client([R2_ROW]), env: { SUPABASE_URL: 'https://p.supabase.co' }, loadProvider });
    const s = await reg.bucketStore('invite-templates');
    expect(s.publicUrl('x.png')).toBe('https://p.supabase.co/storage/v1/object/public/invite-templates/x.png');
  });

  it('lets the env turn it on or off', async () => {
    const rows = [{ id: 'storage', status: 'enabled', config: { supabase_alias: 'r2' } }, R2_ROW];
    const off = createStorageRegistry({ supabase: client(rows), env: { STORAGE_SUPABASE_ALIAS: 'supabase', SUPABASE_URL: 'https://p.supabase.co' }, loadProvider });
    expect((await off.bucketStore('media')).publicUrl('a')).toContain('supabase.co');
    const on = createStorageRegistry({ supabase: client([R2_ROW]), env: { STORAGE_SUPABASE_ALIAS: 'r2' }, loadProvider });
    expect((await on.bucketStore('media')).publicUrl('a')).toBe('https://pub.example/a');
  });

  it('fails rather than quietly going back to Supabase when the provider is unavailable', async () => {
    const c = client([{ id: 'storage', status: 'enabled', config: { supabase_alias: 'r2' } }, { ...R2_ROW, status: 'disabled' }]);
    const reg = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    await expect(reg.bucketStore('media')).rejects.toThrow('not enabled');
  });

  it('refuses a bucket name that could escape its folder', async () => {
    const c = client([{ id: 'storage', status: 'enabled', config: { supabase_alias: 'r2' } }, R2_ROW]);
    const reg = createStorageRegistry({ supabase: c, env: {}, loadProvider });
    await expect(reg.bucketStore('../media')).rejects.toThrow('not a bucket name');
  });
});
