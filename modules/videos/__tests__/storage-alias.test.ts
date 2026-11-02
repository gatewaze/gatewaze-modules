import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseStore } from '../lib/storage';
import { getMedia, mediaUrl, putMedia } from '../lib/studio-media';
import { setSharedStorageRegistry } from '../../storage/lib/bucket-store.js';
import { aliasedTestRegistry, supabaseTestRegistry } from '../../storage/lib/testing.js';

function supabaseDouble() {
  const upload = vi.fn(async () => ({ error: null }));
  const createSignedUrl = vi.fn(async (p: string) => ({ data: { signedUrl: `https://sb.test/sign/${p}` }, error: null }));
  const getPublicUrl = (p: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/media/${p}` } });
  return { upload, createSignedUrl, client: { storage: { from: () => ({ upload, createSignedUrl, getPublicUrl }) } } };
}

const savedUrl = process.env.STORAGE_PUBLIC_URL;
afterEach(() => {
  setSharedStorageRegistry(null);
  vi.unstubAllGlobals();
  if (savedUrl === undefined) delete process.env.STORAGE_PUBLIC_URL;
  else process.env.STORAGE_PUBLIC_URL = savedUrl;
});

describe('videos on a brand still on Supabase', () => {
  it('signs master reads with Supabase', async () => {
    setSharedStorageRegistry(supabaseTestRegistry());
    const s = supabaseDouble();
    expect(await supabaseStore(s.client, 'video-masters').signRead('v/1.mp4', 60)).toBe('https://sb.test/sign/v/1.mp4');
    await putMedia(s.client, 'video-studio/a.png', Buffer.from('x'), 'image/png');
    expect(s.upload).toHaveBeenCalledOnce();
    expect(mediaUrl(s.client, 'video-studio/a.png')).toBe('https://sb.test/storage/v1/object/public/media/video-studio/a.png');
  });
});

describe('videos on a brand that has moved off Supabase', () => {
  it('reads private masters only through signed addresses in the aliased store', async () => {
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = supabaseDouble();
    const store = supabaseStore(s.client, 'video-masters');
    expect(store.provider).toBe('supabase');
    expect(await store.signRead('v/1.mp4', 60)).toBe('https://s3.test/video-masters/v/1.mp4?sig');
    expect(s.createSignedUrl).not.toHaveBeenCalled();
    expect(await store.signUpload('v/2.mp4', 'video/mp4', 60, 10)).toBe('https://s3.test/video-masters/v/2.mp4?sig');
  });

  it('keeps studio pictures in the aliased media store at the brand origin', async () => {
    process.env.STORAGE_PUBLIC_URL = 'https://media.test';
    const t = aliasedTestRegistry();
    setSharedStorageRegistry(t.registry);
    const s = supabaseDouble();
    await putMedia(s.client, 'video-studio/a.png', Buffer.from('x'), 'image/png');
    expect(s.upload).not.toHaveBeenCalled();
    expect(t.calls[0]).toMatchObject({ op: 'put', key: 'video-studio/a.png' });
    expect(mediaUrl(s.client, 'video-studio/a.png')).toBe('https://media.test/video-studio/a.png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200 })));
    expect((await getMedia(s.client, 'video-studio/a.png')).toString()).toBe('x');
  });
});
