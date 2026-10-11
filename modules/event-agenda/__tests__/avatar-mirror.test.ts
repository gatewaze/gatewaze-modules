/**
 * Copying an imported avatar into our own bucket (lib/avatar-mirror.ts).
 *
 * The cases that matter are the ones where a hostile or broken source gets
 * something into a world-readable bucket on our own domain, and the ones where
 * a failure loses an avatar we already had.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  AVATAR_PREFIX,
  avatarStoragePath,
  isMirroredAvatarUrl,
  listMirroredAvatars,
  mirrorAvatar,
  publicAvatarUrl,
  sniffImageType,
} from '../lib/avatar-mirror';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF = new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)));
const WEBP = new Uint8Array([
  ...[...'RIFF'].map((c) => c.charCodeAt(0)),
  0, 0, 0, 0,
  ...[...'WEBP'].map((c) => c.charCodeAt(0)),
]);
const SVG = new Uint8Array([...'<svg onload="alert(1)">'].map((c) => c.charCodeAt(0)));

const REMOTE = '//avatars.sched.co/c/9d/19223528/avatar.jpg?73e';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SUPABASE_PUBLIC_URL;
  process.env.SUPABASE_PUBLIC_URL = 'https://data.test.example';
});
afterEach(() => {
  if (saved === undefined) delete process.env.SUPABASE_PUBLIC_URL;
  else process.env.SUPABASE_PUBLIC_URL = saved;
});

/** A storage double that records what was uploaded. */
function storage(opts: { present?: string[]; uploadError?: string } = {}) {
  const uploads: Array<{ path: string; bytes: number; contentType: string }> = [];
  const present = new Set(opts.present ?? []);
  return {
    uploads,
    present,
    supabase: {
      storage: {
        from: () => ({
          list: async (_prefix: string, o: Record<string, unknown>) => {
            const search = typeof o?.search === 'string' ? o.search : null;
            const names = [...present].map((n) => ({ name: n }));
            return { data: search ? names.filter((n) => n.name === search) : names, error: null };
          },
          upload: async (path: string, body: Uint8Array, o: Record<string, unknown>) => {
            if (opts.uploadError) return { error: { message: opts.uploadError } };
            uploads.push({ path, bytes: body.length, contentType: String(o.contentType) });
            present.add(path.slice(path.lastIndexOf('/') + 1));
            return { error: null };
          },
        }),
      },
    },
  };
}

const fetching = (bytes: Uint8Array, contentType = 'image/png', ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, bytes, contentType, finalUrl: 'https://avatars.sched.co/x' }));

describe('sniffImageType', () => {
  it('recognises the four raster types we store', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses an SVG, whatever it is labelled', () => {
    // The media bucket is world-readable and served from our own origin, so a
    // stored SVG is a stored XSS. Its RLS policy is `USING (bucket_id =
    // 'media')` with no path predicate, so there is nothing else stopping it.
    expect(sniffImageType(SVG)).toBeNull();
  });

  it('refuses an HTML error page and an empty body', () => {
    expect(sniffImageType(new Uint8Array([...'<!DOCTYPE html>'].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('does not read past the end of a short buffer', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});

describe('avatarStoragePath', () => {
  it('is stable for one URL and different for another', () => {
    expect(avatarStoragePath('https://a.sched.co/1.jpg', 'jpg'))
      .toBe(avatarStoragePath('https://a.sched.co/1.jpg', 'jpg'));
    expect(avatarStoragePath('https://a.sched.co/1.jpg', 'jpg'))
      .not.toBe(avatarStoragePath('https://a.sched.co/2.jpg', 'jpg'));
  });

  it('changes when the cache-busting suffix does, so a new photo is not missed', () => {
    expect(avatarStoragePath('https://a.sched.co/1.jpg?73e', 'jpg'))
      .not.toBe(avatarStoragePath('https://a.sched.co/1.jpg?99f', 'jpg'));
  });

  it('never lets the extension escape the prefix', () => {
    const p = avatarStoragePath('https://a.sched.co/1.jpg', '../../etc/passwd');
    expect(p.startsWith(`${AVATAR_PREFIX}/`)).toBe(true);
    expect(p).not.toContain('..');
    expect(p.endsWith('.bin')).toBe(true);
  });
});

describe('publicAvatarUrl', () => {
  it('builds the shape every consumer already handles', () => {
    expect(publicAvatarUrl('x/y.jpg')).toBe('https://data.test.example/storage/v1/object/public/media/x/y.jpg');
  });

  it('returns null rather than a URL with no host', () => {
    delete process.env.SUPABASE_PUBLIC_URL;
    expect(publicAvatarUrl('x/y.jpg')).toBeNull();
  });

  it('does not fall back to the in-cluster SUPABASE_URL', () => {
    // A browser cannot resolve http://supabase-kong:8000, so storing it would
    // put a broken image on every page.
    delete process.env.SUPABASE_PUBLIC_URL;
    process.env.SUPABASE_URL = 'http://supabase-kong:8000';
    expect(publicAvatarUrl('x/y.jpg')).toBeNull();
    delete process.env.SUPABASE_URL;
  });
});

describe('mirrorAvatar', () => {
  it('copies a protocol-relative sched avatar and returns our URL', async () => {
    const s = storage();
    const fetchBytes = fetching(JPEG, 'image/jpeg');
    const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes }, REMOTE);
    expect(r?.storagePath).toBe(avatarStoragePath('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e', 'jpg'));
    expect(r?.url).toContain('https://data.test.example/storage/v1/object/public/media/');
    expect(r?.mime).toBe('image/jpeg');
    expect(r?.reused).toBe(false);
    expect(s.uploads).toHaveLength(1);
    expect(s.uploads[0].contentType).toBe('image/jpeg');
  });

  it('passes the avatar cap to the fetch, not the programme-page cap', async () => {
    const s = storage();
    const fetchBytes = fetching(PNG);
    await mirrorAvatar({ supabase: s.supabase, fetchBytes }, REMOTE);
    expect(fetchBytes).toHaveBeenCalledWith(expect.any(String), expect.any(Array), AVATAR_MAX_BYTES);
  });

  it('returns null for a URL it would never use, rather than hot-linking it', async () => {
    const s = storage();
    const fetchBytes = fetching(PNG);
    expect(await mirrorAvatar({ supabase: s.supabase, fetchBytes }, 'https://tracker.example.com/p.gif')).toBeNull();
    expect(await mirrorAvatar({ supabase: s.supabase, fetchBytes }, 'javascript:alert(1)')).toBeNull();
    expect(await mirrorAvatar({ supabase: s.supabase, fetchBytes }, null)).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('stores nothing when the bytes are not a raster image', async () => {
    const s = storage();
    // Labelled image/png, actually an SVG. The label is the attacker's claim.
    const fetchBytes = fetching(SVG, 'image/png');
    const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes }, REMOTE);
    expect(s.uploads).toHaveLength(0);
    expect(r?.storagePath).toBeNull();
    expect(r?.url).toBe('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e');
    expect(r?.skippedReason).toContain('not a raster image');
  });

  it('falls back to the remote URL when the fetch fails, so no avatar is lost', async () => {
    const s = storage();
    for (const fetchBytes of [
      fetching(new Uint8Array(0), '', false, 404),
      fetching(new Uint8Array(0), 'image/png'),
      vi.fn(async () => { throw new Error('socket hang up'); }),
    ]) {
      const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes: fetchBytes as never }, REMOTE);
      expect(r?.storagePath).toBeNull();
      expect(r?.url).toBe('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e');
    }
    expect(s.uploads).toHaveLength(0);
  });

  it('falls back when the upload fails', async () => {
    const s = storage({ uploadError: 'bucket is full' });
    const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes: fetching(PNG) }, REMOTE);
    expect(r?.storagePath).toBeNull();
    expect(r?.skippedReason).toContain('bucket is full');
  });

  it('does not fetch at all when there is no public URL to store', async () => {
    delete process.env.SUPABASE_PUBLIC_URL;
    const s = storage();
    const fetchBytes = fetching(PNG);
    const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes }, REMOTE);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(r?.url).toBe('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e');
  });

  it('reuses an object it already holds without fetching', async () => {
    const path = avatarStoragePath('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e', 'jpg');
    const s = storage({ present: [path.slice(path.lastIndexOf('/') + 1)] });
    const fetchBytes = fetching(JPEG, 'image/jpeg');
    const r = await mirrorAvatar({ supabase: s.supabase, fetchBytes }, REMOTE);
    expect(r?.reused).toBe(true);
    expect(r?.storagePath).toBe(path);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('reuses from a pre-read set without any storage call', async () => {
    const path = avatarStoragePath('https://avatars.sched.co/c/9d/19223528/avatar.jpg?73e', 'jpg');
    const listed = vi.fn();
    const supabase = { storage: { from: () => ({ list: listed, upload: listed }) } };
    const fetchBytes = fetching(JPEG, 'image/jpeg');
    const r = await mirrorAvatar(
      { supabase: supabase as never, fetchBytes, existing: new Set([path.slice(path.lastIndexOf('/') + 1)]) },
      REMOTE,
    );
    expect(r?.reused).toBe(true);
    expect(listed).not.toHaveBeenCalled();
  });
});

describe('listMirroredAvatars', () => {
  it('pages until a short page', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ name: `a${i}.jpg` })),
      [{ name: 'tail.jpg' }],
    ];
    let call = 0;
    const supabase = {
      storage: { from: () => ({ list: async () => ({ data: pages[call++] ?? [], error: null }), upload: async () => ({}) }) },
    };
    const names = await listMirroredAvatars({ supabase: supabase as never });
    expect(names.size).toBe(1001);
    expect(names.has('tail.jpg')).toBe(true);
    expect(call).toBe(2);
  });

  it('stops on an error with a partial set, which only costs a re-download', async () => {
    const supabase = {
      storage: { from: () => ({ list: async () => ({ data: null, error: { message: 'boom' } }), upload: async () => ({}) }) },
    };
    await expect(listMirroredAvatars({ supabase: supabase as never })).resolves.toBeInstanceOf(Set);
  });
});

describe('isMirroredAvatarUrl', () => {
  it('recognises our own URLs and nothing else', () => {
    expect(isMirroredAvatarUrl(`https://data.test.example/storage/v1/object/public/media/${AVATAR_PREFIX}/abc.jpg`)).toBe(true);
    expect(isMirroredAvatarUrl('https://avatars.sched.co/a.jpg')).toBe(false);
    expect(isMirroredAvatarUrl('avatars/promo-123.png')).toBe(false);
    expect(isMirroredAvatarUrl(null)).toBe(false);
  });
});
