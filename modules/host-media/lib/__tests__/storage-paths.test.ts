import { describe, it, expect } from 'vitest';
import { sanitiseFilename, buildStoragePath, buildChunkStoragePath } from '../storage-paths.js';

describe('sanitiseFilename', () => {
  it('slugifies spaces (Gmail refuses to load img src with literal spaces)', () => {
    expect(sanitiseFilename('The RePPIT framework.png')).toBe('the-reppit-framework.png');
    expect(sanitiseFilename('my file name.jpg')).toBe('my-file-name.jpg');
  });

  it('lowercases the extension', () => {
    expect(sanitiseFilename('Photo.JPG')).toBe('photo.jpg');
    expect(sanitiseFilename('IMG_001.PNG')).toBe('img-001.png');
  });

  it('collapses path separators + traversal into the slug', () => {
    expect(sanitiseFilename('../../../etc/passwd')).toBe('etc-passwd');
    expect(sanitiseFilename('foo/bar.jpg')).toBe('foo-bar.jpg');
    expect(sanitiseFilename('foo\\bar.jpg')).toBe('foo-bar.jpg');
  });

  it('strips NUL bytes', () => {
    expect(sanitiseFilename('a\x00b.jpg')).toBe('ab.jpg');
  });

  it('handles accented / non-ASCII chars (replaced with dashes)', () => {
    expect(sanitiseFilename('cafetería.png')).toBe('cafeter-a.png');
  });

  it('falls back to `file` when the base is all unsafe chars', () => {
    expect(sanitiseFilename('!!!.png')).toBe('file.png');
    expect(sanitiseFilename('   .jpg')).toBe('file.jpg');
  });

  it('caps length at 200', () => {
    const long = 'a'.repeat(300) + '.jpg';
    expect(sanitiseFilename(long).length).toBe(200);
  });

  it('preserves extension + benign chars', () => {
    expect(sanitiseFilename('photo-2026-05-07.jpg')).toBe('photo-2026-05-07.jpg');
  });
});

describe('buildStoragePath', () => {
  it('builds the host_kind/host_id/media_id/filename pattern', () => {
    const path = buildStoragePath(
      'site',
      '7ffd554a-21d1-452d-a3ec-bcf952fb1652',
      '11111111-2222-3333-4444-555555555555',
      'hero.jpg',
    );
    expect(path).toBe('site/7ffd554a-21d1-452d-a3ec-bcf952fb1652/11111111-2222-3333-4444-555555555555/hero.jpg');
  });

  it('sanitises filename in the path', () => {
    const path = buildStoragePath('event', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '../escape.jpg');
    expect(path).toContain('escape.jpg');
    expect(path).not.toContain('..');
  });

  it('produces a URL-safe path for filenames with spaces', () => {
    const path = buildStoragePath('newsletter', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'The RePPIT framework.png');
    expect(path).toBe('newsletter/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/the-reppit-framework.png');
    expect(path).not.toContain(' ');
  });
});

describe('buildChunkStoragePath', () => {
  it('uses the __chunked subdirectory + chunk index', () => {
    const path = buildChunkStoragePath('site', '7ffd554a-21d1-452d-a3ec-bcf952fb1652', '11111111-2222-3333-4444-555555555555', 7);
    expect(path).toBe('site/7ffd554a-21d1-452d-a3ec-bcf952fb1652/__chunked/11111111-2222-3333-4444-555555555555/7');
  });
});
