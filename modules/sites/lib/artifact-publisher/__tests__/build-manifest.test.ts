import { describe, expect, it } from 'vitest';
import { buildFileManifest, manifestDelta } from '../build-manifest.js';

describe('buildFileManifest()', () => {
  it('emits sha256 + size per entry', () => {
    const out = buildFileManifest([
      { relPath: 'index.html', bytes: Buffer.from('hello', 'utf8') },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe('index.html');
    expect(out[0]?.size).toBe(5);
    expect(out[0]?.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('sorts the manifest by relPath for stability', () => {
    const out = buildFileManifest([
      { relPath: 'z.html', bytes: Buffer.from('z') },
      { relPath: 'a.html', bytes: Buffer.from('a') },
      { relPath: 'm.html', bytes: Buffer.from('m') },
    ]);
    expect(out.map((e) => e.relPath)).toEqual(['a.html', 'm.html', 'z.html']);
  });

  it('rejects duplicate relPaths', () => {
    expect(() =>
      buildFileManifest([
        { relPath: 'a', bytes: Buffer.from('1') },
        { relPath: 'a', bytes: Buffer.from('2') },
      ]),
    ).toThrow(/duplicate relPath/);
  });

  it('rejects absolute paths', () => {
    expect(() =>
      buildFileManifest([{ relPath: '/etc/passwd', bytes: Buffer.from('x') }]),
    ).toThrow(/must be relative/);
  });

  it('rejects parent-traversal paths', () => {
    expect(() =>
      buildFileManifest([{ relPath: '../escape', bytes: Buffer.from('x') }]),
    ).toThrow(/must be relative/);
  });

  it('accepts Uint8Array as well as Buffer', () => {
    const u8 = new TextEncoder().encode('hello');
    const out = buildFileManifest([{ relPath: 'x', bytes: u8 }]);
    expect(out[0]?.size).toBe(5);
  });
});

describe('manifestDelta()', () => {
  it('reports new + changed files in changed[]', () => {
    const baseline = [
      { relPath: 'a', sha256: 'aaa', size: 1 },
      { relPath: 'b', sha256: 'bbb', size: 1 },
    ];
    const next = [
      { relPath: 'a', sha256: 'aaa', size: 1 },     // unchanged
      { relPath: 'b', sha256: 'changed', size: 2 }, // changed
      { relPath: 'c', sha256: 'ccc', size: 1 },     // added
    ];
    const { changed, removed } = manifestDelta(baseline, next);
    expect(changed.map((e) => e.relPath).sort()).toEqual(['b', 'c']);
    expect(removed).toEqual([]);
  });

  it('reports removed files in removed[]', () => {
    const baseline = [
      { relPath: 'a', sha256: 'aaa', size: 1 },
      { relPath: 'b', sha256: 'bbb', size: 1 },
    ];
    const next = [{ relPath: 'a', sha256: 'aaa', size: 1 }];
    const { changed, removed } = manifestDelta(baseline, next);
    expect(changed).toHaveLength(0);
    expect(removed).toEqual(['b']);
  });

  it('returns empty deltas when manifests are identical', () => {
    const m = [
      { relPath: 'a', sha256: 'aaa', size: 1 },
      { relPath: 'b', sha256: 'bbb', size: 1 },
    ];
    const { changed, removed } = manifestDelta(m, m);
    expect(changed).toHaveLength(0);
    expect(removed).toEqual([]);
  });
});
