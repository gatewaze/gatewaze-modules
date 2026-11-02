import { afterEach, describe, expect, it } from 'vitest';
import { extractMediaReferences, normalizeToStoragePath } from '../reference-tracker.js';

describe('extractMediaReferences', () => {
  it('finds an image_url at the top level', () => {
    const refs = extractMediaReferences({ image_url: '/media/hero.jpg', headline: 'Welcome' });
    expect([...refs]).toEqual(['media/hero.jpg']);
  });

  it('walks nested objects + arrays', () => {
    const refs = extractMediaReferences({
      blocks: [
        { content: { image: '/media/a.jpg' } },
        { content: { background_image: '/media/b.jpg', headline: 'no media' } },
      ],
    });
    expect([...refs].sort()).toEqual(['media/a.jpg', 'media/b.jpg']);
  });

  it('matches *_image suffix pattern', () => {
    const refs = extractMediaReferences({ hero_image: '/media/x.jpg', og_image: '/media/y.jpg' });
    expect([...refs].sort()).toEqual(['media/x.jpg', 'media/y.jpg']);
  });

  it('caps recursion at MAX_DEPTH=10', () => {
    let nested: unknown = { image: '/media/deep.jpg' };
    for (let i = 0; i < 15; i++) nested = { wrap: nested };
    const refs = extractMediaReferences(nested);
    expect(refs.size).toBe(0); // Beyond depth, image not found
  });

  it('ignores string fields whose key does not match the media-key regex', () => {
    const refs = extractMediaReferences({ headline: '/media/foo.jpg', body: 'visit /media/bar.jpg' });
    expect(refs.size).toBe(0);
  });
});

describe('normalizeToStoragePath', () => {
  it('strips leading slashes from relative paths', () => {
    expect(normalizeToStoragePath('/media/hero.jpg')).toBe('media/hero.jpg');
    expect(normalizeToStoragePath('//media/hero.jpg')).toBe('media/hero.jpg');
  });

  it('returns relative paths unchanged (sans leading /)', () => {
    expect(normalizeToStoragePath('sites/foo/media/hero.jpg')).toBe('sites/foo/media/hero.jpg');
  });

  it('strips Supabase storage + public prefix when bucket URL matches', () => {
    expect(
      normalizeToStoragePath(
        'https://api.brand.com/storage/v1/object/public/sites/foo/media/hero.jpg',
        'https://api.brand.com',
      ),
    ).toBe('sites/foo/media/hero.jpg');
  });

  it('strips query strings + fragments', () => {
    expect(normalizeToStoragePath('/media/hero.jpg?width=320#top')).toBe('media/hero.jpg');
  });

  it('returns null for opaque external URLs', () => {
    expect(normalizeToStoragePath('https://other.example.com/foo.jpg', 'https://api.brand.com')).toBeNull();
  });
});

describe('normalizeToStoragePath on a brand that has moved off Supabase Storage', () => {
  const saved = { url: process.env.STORAGE_PUBLIC_URL, hosts: process.env.STORAGE_LEGACY_HOSTS };
  afterEach(() => {
    if (saved.url === undefined) delete process.env.STORAGE_PUBLIC_URL; else process.env.STORAGE_PUBLIC_URL = saved.url;
    if (saved.hosts === undefined) delete process.env.STORAGE_LEGACY_HOSTS; else process.env.STORAGE_LEGACY_HOSTS = saved.hosts;
  });

  it('reads paths from the new origin and from the old Supabase host', () => {
    process.env.STORAGE_PUBLIC_URL = 'https://media.test';
    process.env.STORAGE_LEGACY_HOSTS = 'old.supabase.co';
    const base = 'https://media.test';
    expect(normalizeToStoragePath('https://media.test/sites/s1/media/a.webp', base)).toBe('sites/s1/media/a.webp');
    expect(normalizeToStoragePath('https://media.test/cdn-cgi/image/width=640,fit=scale-down,quality=80,format=auto/sites/s1/media/a.webp', base)).toBe('sites/s1/media/a.webp');
    expect(normalizeToStoragePath('https://old.supabase.co/storage/v1/object/public/media/sites/s1/media/a.webp', base)).toBe('sites/s1/media/a.webp');
    expect(normalizeToStoragePath('https://other.example/a.webp', base)).toBeNull();
  });

  it('is unchanged without STORAGE_PUBLIC_URL', () => {
    delete process.env.STORAGE_PUBLIC_URL;
    expect(normalizeToStoragePath('https://p.supabase.co/storage/v1/object/public/media/sites/s1/a.webp', 'https://p.supabase.co')).toBe('sites/s1/a.webp');
  });
});
