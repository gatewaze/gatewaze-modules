import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.fn(async () => ({ error: null as null | { message: string } }));
const remove = vi.fn(async () => ({ error: null as null | { message: string } }));
const getPublicUrl = vi.fn((p: string) => ({ data: { publicUrl: `https://p.supabase.co/storage/v1/object/public/b/${p}` } }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload, remove, getPublicUrl }) },
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  },
}));

import { publicStorageUrl, removeFromStorage, rewriteStorageUrl, storageConfig, uploadToStorage } from '../storage';

const g = globalThis as { __GATEWAZE_CONFIG__?: Record<string, string> };

function configure(on: boolean) {
  g.__GATEWAZE_CONFIG__ = on
    ? { VITE_STORAGE_PUBLIC_URL: 'https://media.test', VITE_STORAGE_LEGACY_HOSTS: 'p.supabase.co', VITE_API_URL: 'https://api.test/' }
    : { VITE_API_URL: 'https://api.test' };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  upload.mockClear();
  remove.mockClear();
});
afterEach(() => {
  delete g.__GATEWAZE_CONFIG__;
  vi.unstubAllGlobals();
});

describe('addresses', () => {
  it('use Supabase when the brand is not configured', () => {
    configure(false);
    expect(storageConfig().publicUrl).toBe('');
    expect(publicStorageUrl('b', 'x/y.png')).toBe('https://p.supabase.co/storage/v1/object/public/b/x/y.png');
    const old = 'https://p.supabase.co/storage/v1/object/public/media/a.png';
    expect(rewriteStorageUrl(old)).toBe(old);
  });

  it('use the brand origin and the prefix rule when configured', () => {
    configure(true);
    expect(publicStorageUrl('media', 'x/y.png')).toBe('https://media.test/x/y.png');
    expect(publicStorageUrl('downloads', 'a b.pdf')).toBe('https://media.test/downloads/a%20b.pdf');
    expect(rewriteStorageUrl('https://p.supabase.co/storage/v1/object/public/invite-templates/e/1.png')).toBe('https://media.test/invite-templates/e/1.png');
    expect(rewriteStorageUrl('https://other.supabase.co/storage/v1/object/public/media/a.png')).toBe('https://other.supabase.co/storage/v1/object/public/media/a.png');
  });
});

describe('uploadToStorage', () => {
  const file = new Blob(['hello'], { type: 'image/png' });

  it('calls supabase-js exactly as before when not configured', async () => {
    configure(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await uploadToStorage('b', 'x.png', file, { upsert: true, contentType: 'image/png' });
    expect(upload).toHaveBeenCalledWith('x.png', file, { upsert: true, contentType: 'image/png' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({ path: 'x.png', publicUrl: 'https://p.supabase.co/storage/v1/object/public/b/x.png' });
  });

  it('throws the supabase error message', async () => {
    configure(false);
    upload.mockResolvedValueOnce({ error: { message: 'denied' } });
    await expect(uploadToStorage('b', 'x.png', file)).rejects.toThrow('denied');
  });

  it('signs through the API and PUTs with exactly the returned headers', async () => {
    configure(true);
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://api.test/api/storage/sign-upload') {
        return json(200, { url: 'https://s3.test/put?sig', method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '5' }, bucket: 'media', path: 'talks/u-x.png', publicUrl: 'https://media.test/talks/u-x.png' });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await uploadToStorage('media', 'talks/x.png', file);
    expect(r).toEqual({ path: 'talks/u-x.png', publicUrl: 'https://media.test/talks/u-x.png' });
    const [, signInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(signInit!.body))).toEqual({ bucket: 'media', path: 'talks/x.png', contentType: 'image/png', bytes: 5, upsert: false });
    expect((signInit!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const [putUrl, putInit] = fetchMock.mock.calls[1]!;
    expect(putUrl).toBe('https://s3.test/put?sig');
    expect(putInit!.headers).toEqual({ 'content-type': 'image/png', 'content-length': '5' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('falls back to supabase-js when the API is not enabled', async () => {
    configure(true);
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'not_enabled' })));
    await uploadToStorage('b', 'x.png', file);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('surfaces a refusal and a failed PUT', async () => {
    configure(true);
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: 'forbidden' })));
    await expect(uploadToStorage('b', 'x.png', file)).rejects.toThrow('forbidden');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/api/') ? json(200, { url: 'https://s3.test/p', method: 'PUT', headers: {}, bucket: 'b', path: 'x.png', publicUrl: 'u' }) : new Response(null, { status: 403 }))));
    await expect(uploadToStorage('b', 'x.png', file)).rejects.toThrow('HTTP 403');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('removeFromStorage', () => {
  it('uses supabase-js when not configured', async () => {
    configure(false);
    await removeFromStorage('b', ['x.png']);
    expect(remove).toHaveBeenCalledWith(['x.png']);
  });

  it('uses the API when configured and reports failures', async () => {
    configure(true);
    const fetchMock = vi.fn(async () => json(200, { failed: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await removeFromStorage('b', ['x.png']);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/api/storage/delete');
    expect(remove).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { failed: ['x.png'] })));
    await expect(removeFromStorage('b', ['x.png'])).rejects.toThrow('could not remove');
  });

  it('falls back when the API is not enabled', async () => {
    configure(true);
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'not_enabled' })));
    await removeFromStorage('b', ['x.png']);
    expect(remove).toHaveBeenCalledOnce();
  });
});
