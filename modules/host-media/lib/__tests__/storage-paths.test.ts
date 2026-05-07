import { describe, it, expect } from 'vitest';
import { sanitiseFilename, buildStoragePath, buildChunkStoragePath } from '../storage-paths.js';

describe('sanitiseFilename', () => {
  it('strips path-traversal', () => {
    expect(sanitiseFilename('../../../etc/passwd')).toBe('______etc_passwd');
    expect(sanitiseFilename('foo/bar.jpg')).toBe('foo_bar.jpg');
    expect(sanitiseFilename('foo\\bar.jpg')).toBe('foo_bar.jpg');
  });

  it('strips NUL bytes', () => {
    expect(sanitiseFilename('a\x00b.jpg')).toBe('ab.jpg');
  });

  it('preserves spaces (browsers/storage URL-encode them)', () => {
    expect(sanitiseFilename('my file name.jpg')).toBe('my file name.jpg');
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
    expect(path).toContain('__escape.jpg');
    expect(path).not.toContain('..');
  });
});

describe('buildChunkStoragePath', () => {
  it('uses the __chunked subdirectory + chunk index', () => {
    const path = buildChunkStoragePath('site', '7ffd554a-21d1-452d-a3ec-bcf952fb1652', '11111111-2222-3333-4444-555555555555', 7);
    expect(path).toBe('site/7ffd554a-21d1-452d-a3ec-bcf952fb1652/__chunked/11111111-2222-3333-4444-555555555555/7');
  });
});
