import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMedia, putMedia } from '../lib/promo/media-store';
import { ownStoragePath, resolveAvatarDataUri } from '../lib/promo/render-cards';
import { setSharedStorageRegistry } from '../../storage/lib/bucket-store.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../../storage/lib/testing.js';

function supabaseDouble() {
  const upload = vi.fn(async () => ({ error: null }));
  const download = vi.fn(async () => ({ data: new Blob([Buffer.from('png')]) }));
  return { upload, download, client: { storage: { from: () => ({ upload, download }) } } };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.STORAGE_PUBLIC_URL;
});
afterEach(() => {
  setSharedStorageRegistry(null);
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.STORAGE_PUBLIC_URL;
  else process.env.STORAGE_PUBLIC_URL = saved;
});

describe('promo kit media, brand still on Supabase', () => {
  it('uploads and downloads with supabase-js as before', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    const s = supabaseDouble();
    await putMedia(s.client, 'speaker-promo/e/t/card.png', Buffer.from('x'), { contentType: 'image/png', noCache: true });
    expect(s.upload).toHaveBeenCalledWith('speaker-promo/e/t/card.png', expect.any(Buffer), { contentType: 'image/png', cacheControl: '0', upsert: true });
    expect((await downloadMedia(s.client, 'a.png'))?.toString()).toBe('png');
  });
});

describe('promo kit media, brand moved off Supabase', () => {
  it('writes to and reads from the aliased store', async () => {
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = supabaseDouble();
    await putMedia(s.client, 'speaker-promo/e/t/kit.zip', Buffer.from('zip'), { contentType: 'application/zip', noCache: true });
    expect(s.upload).not.toHaveBeenCalled();
    expect(t.calls[0]).toMatchObject({ op: 'put', key: 'speaker-promo/e/t/kit.zip', opts: { contentType: 'application/zip', upsert: true, cacheControl: 'max-age=0' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('zip', { status: 200 })));
    expect((await downloadMedia(s.client, 'speaker-promo/e/t/kit.zip'))?.toString()).toBe('zip');
    expect(s.download).not.toHaveBeenCalled();
  });

  it('reads an avatar on the brand origin through the store, and never a private folder', async () => {
    process.env.STORAGE_PUBLIC_URL = 'https://media.test';
    setSharedStorageRegistry(aliasedTestRegistry().registry);
    expect(ownStoragePath('https://media.test/profiles/a%20b.jpg')).toBe('profiles/a b.jpg');
    expect(ownStoragePath('https://media.test/cdn-cgi/image/width=1/x.jpg')).toBeNull();
    expect(ownStoragePath('https://media.test/x.jpg?v=1')).toBeNull();
    expect(ownStoragePath('https://media.test/a/../b.jpg')).toBeNull();
    const fetchMock = vi.fn(async () => new Response(Buffer.from('jpg'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const s = supabaseDouble();
    expect(await resolveAvatarDataUri(s.client, 'https://media.test/profiles/a.jpg')).toBe(`data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://s3.test/profiles/a.jpg?sig');
    fetchMock.mockClear();
    expect(await resolveAvatarDataUri(s.client, 'https://media.test/photo-booth-feedback/x.jpg')).toBeNull();
    expect(await resolveAvatarDataUri(s.client, 'video-masters/v.jpg')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
