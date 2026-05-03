import { describe, expect, it } from 'vitest';
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
