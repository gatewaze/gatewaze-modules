/**
 * Unit tests for the git source helpers — focused on the pure parts that
 * don't actually shell out to `git`. The clone/apply path needs a real git
 * binary + a fixture repo and is exercised in the integration suite.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { walkSourceFiles, cloneOrUpdateGitSource, assertHostInEgressAllowlist } from '../git.js';

describe('walkSourceFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gatewaze-git-test-'));
  });

  function write(rel: string, content: string): void {
    const full = resolve(dir, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  it('returns html, htm, mjml files (sorted, recursive)', () => {
    write('a.html', '<p>a</p>');
    write('b.mjml', '<mjml/>');
    write('c.htm', '<p>c</p>');
    write('sub/d.html', '<p>d</p>');
    write('readme.md', 'ignored'); // wrong ext
    const files = walkSourceFiles(dir);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      'a.html',
      'b.mjml',
      'c.htm',
      'sub/d.html',
    ]);
  });

  it('skips .git, node_modules, dist, build, .next, .turbo dirs', () => {
    write('top.html', '<p>top</p>');
    write('.git/HEAD', 'ref: refs/heads/main'); // not html anyway
    write('node_modules/lib.html', '<p>lib</p>');
    write('dist/built.html', '<p>built</p>');
    write('build/out.html', '<p>out</p>');
    write('.next/page.html', '<p>page</p>');
    write('.turbo/cache.html', '<p>cache</p>');
    const files = walkSourceFiles(dir);
    expect(files.map((f) => f.relativePath)).toEqual(['top.html']);
  });

  it('honours manifest_path subdirectory scope', () => {
    write('outside.html', '<p/>');
    write('themes/wedding/page.html', '<p/>');
    write('themes/wedding/layout.mjml', '<mjml/>');
    const files = walkSourceFiles(dir, 'themes/wedding');
    expect(files.length).toBe(2);
    expect(files.every((f) => f.relativePath.startsWith('themes/wedding/'))).toBe(true);
  });

  it('throws when manifest_path does not exist', () => {
    write('a.html', '<p/>');
    expect(() => walkSourceFiles(dir, 'no-such-folder')).toThrow(/does not exist/);
  });

  it('throws when no template files are found', () => {
    write('readme.md', 'no html here');
    expect(() => walkSourceFiles(dir)).toThrow(/no template files found/);
  });

  it('throws when a single file exceeds 1 MB cap', () => {
    write('big.html', 'x'.repeat(1024 * 1024 + 100));
    expect(() => walkSourceFiles(dir)).toThrow(/exceeds 1 MB cap/);
  });

  it('returns each file with its content', () => {
    write('greeting.html', '<p>hello world</p>');
    const files = walkSourceFiles(dir);
    expect(files[0]?.content).toBe('<p>hello world</p>');
  });
});

describe('assertHostInEgressAllowlist', () => {
  it('passes everything when EGRESS_ALLOWLIST is unset', () => {
    expect(() => assertHostInEgressAllowlist('https://github.com/x/y.git', {})).not.toThrow();
  });

  it('passes everything when EGRESS_ALLOWLIST is empty string', () => {
    expect(() => assertHostInEgressAllowlist('https://evil.example/x/y.git', { EGRESS_ALLOWLIST: '' })).not.toThrow();
  });

  it('rejects hosts not in the allowlist (spec §15.6 acceptance criterion)', () => {
    expect(() =>
      assertHostInEgressAllowlist('https://evil.example/x/y.git', { EGRESS_ALLOWLIST: 'trusted.example' }),
    ).toThrow(/egress_blocked/);
  });

  it('accepts hosts in the allowlist', () => {
    expect(() =>
      assertHostInEgressAllowlist('https://trusted.example/x/y.git', { EGRESS_ALLOWLIST: 'trusted.example' }),
    ).not.toThrow();
  });

  it('is case-insensitive on hostname', () => {
    expect(() =>
      assertHostInEgressAllowlist('https://GitHub.com/x/y', { EGRESS_ALLOWLIST: 'github.com' }),
    ).not.toThrow();
  });

  it('does NOT do subdomain matching (spec: explicit only)', () => {
    expect(() =>
      assertHostInEgressAllowlist('https://gist.github.com/x/y', { EGRESS_ALLOWLIST: 'github.com' }),
    ).toThrow(/egress_blocked/);
  });

  it('supports multiple comma-separated entries', () => {
    expect(() =>
      assertHostInEgressAllowlist('https://gitlab.com/x/y', { EGRESS_ALLOWLIST: 'github.com, gitlab.com, bitbucket.org' }),
    ).not.toThrow();
    expect(() =>
      assertHostInEgressAllowlist('https://evil.com/x/y', { EGRESS_ALLOWLIST: 'github.com, gitlab.com' }),
    ).toThrow(/egress_blocked/);
  });

  it('rejects unparseable URLs', () => {
    expect(() => assertHostInEgressAllowlist('not-a-url', { EGRESS_ALLOWLIST: 'github.com' })).toThrow(/egress_blocked/);
  });
});

describe('cloneOrUpdateGitSource — input validation', () => {
  it('rejects non-http(s) urls', () => {
    expect(() => cloneOrUpdateGitSource({ url: 'file:///etc/passwd' })).toThrow(/http/i);
    expect(() => cloneOrUpdateGitSource({ url: 'ssh://git@github.com/x/y' })).toThrow(/http/i);
  });

  it('rejects urls embedding credentials', () => {
    expect(() => cloneOrUpdateGitSource({ url: 'https://user:pass@github.com/x/y.git' })).toThrow(/credentials/);
  });

  it('rejects unsafe branch names', () => {
    expect(() => cloneOrUpdateGitSource({ url: 'https://github.com/x/y.git', branch: 'main; rm -rf' })).toThrow(/unsafe/);
    expect(() => cloneOrUpdateGitSource({ url: 'https://github.com/x/y.git', branch: '$(whoami)' })).toThrow(/unsafe/);
  });

  it('accepts safe branch shapes (slash, dot, dash, underscore, alnum)', () => {
    // Don't actually clone — just confirm validation passes by clone failing
    // for the network reason, not the validation reason.
    const cacheDir = mkdtempSync(resolve(tmpdir(), 'gatewaze-git-clone-'));
    try {
      // .invalid TLD per RFC 6761 — DNS will refuse, clone fails fast.
      // The validation must NOT be the failure reason.
      let validationError: unknown = null;
      try {
        cloneOrUpdateGitSource({
          url: 'https://example.invalid/x/y.git',
          branch: 'release/v1.2.3',
          cacheDir,
        });
      } catch (e) {
        validationError = e;
      }
      // Whatever this threw, it should NOT mention "unsafe" — the branch
      // passed validation; the failure was the unreachable host.
      expect(String(validationError)).not.toMatch(/unsafe/i);
    } finally {
      if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
