import { describe, expect, it } from 'vitest';
import { buildSha1Manifest } from '../sha1-manifest.js';

describe('buildSha1Manifest()', () => {
  it('computes SHA-1 + size per entry and prefixes paths with /', async () => {
    const m = await buildSha1Manifest([
      { relPath: 'index.html', bytes: Buffer.from('hello', 'utf8') },
    ]);
    // SHA-1 of "hello" = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    expect(m.files['/index.html']).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(m.entries[0]?.relPath).toBe('index.html');
    expect(m.entries[0]?.size).toBe(5);
  });

  it('sorts entries by relPath for stability', async () => {
    const m = await buildSha1Manifest([
      { relPath: 'z', bytes: Buffer.from('z') },
      { relPath: 'a', bytes: Buffer.from('a') },
      { relPath: 'm', bytes: Buffer.from('m') },
    ]);
    expect(m.entries.map((e) => e.relPath)).toEqual(['a', 'm', 'z']);
  });

  it('rejects duplicate relPaths', async () => {
    await expect(
      buildSha1Manifest([
        { relPath: 'a', bytes: Buffer.from('1') },
        { relPath: 'a', bytes: Buffer.from('2') },
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  it('rejects absolute / parent-traversal paths', async () => {
    await expect(buildSha1Manifest([{ relPath: '/etc', bytes: Buffer.from('x') }])).rejects.toThrow(/relative/);
    await expect(buildSha1Manifest([{ relPath: '../escape', bytes: Buffer.from('x') }])).rejects.toThrow(/relative/);
  });

  it('accepts Uint8Array as well as Buffer', async () => {
    const m = await buildSha1Manifest([{ relPath: 'a', bytes: new TextEncoder().encode('hello') }]);
    expect(m.entries[0]?.size).toBe(5);
  });
});
