/**
 * Tests for the newsletter theme-overlay helper. Mirrors the structure
 * of sites' theme-overlay.test.ts (we don't share code across modules,
 * so the same shape of test lives here too).
 *
 * We exercise pure URL-rewriting (injectTokenInUrl) plus the full
 * applyThemeOverlay flow against a real on-disk git repo created in a
 * tmp dir — that lets us assert filesOverlaid + clonedSha + the
 * write-LAST precedence rule without mocking spawn.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyThemeOverlay, injectTokenInUrl } from '../theme-overlay.js';

describe('injectTokenInUrl', () => {
  it('injects token into https github url', () => {
    expect(injectTokenInUrl('https://github.com/foo/bar.git', 'ghp_x')).toBe(
      'https://x-access-token:ghp_x@github.com/foo/bar.git',
    );
  });
  it('leaves ssh urls alone', () => {
    expect(injectTokenInUrl('git@github.com:foo/bar.git', 'ghp_x')).toBe('git@github.com:foo/bar.git');
  });
  it('leaves credentialed urls alone (idempotent)', () => {
    expect(injectTokenInUrl('https://x-access-token:tok@github.com/foo/bar.git', 'tok2')).toBe(
      'https://x-access-token:tok@github.com/foo/bar.git',
    );
  });
  it('passes through unchanged when no token', () => {
    expect(injectTokenInUrl('https://github.com/foo/bar.git', undefined)).toBe(
      'https://github.com/foo/bar.git',
    );
  });
});

describe('applyThemeOverlay — file injection', () => {
  let workRoot: string;
  let themeRepoPath: string;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'gatewaze-overlay-test-'));
    themeRepoPath = join(workRoot, 'theme-repo');

    // Build a tiny local theme repo with a couple of files and a
    // subdir, then commit on a known branch.
    await mkdir(themeRepoPath, { recursive: true });
    await writeFile(join(themeRepoPath, 'package.json'), '{"name":"theme"}');
    await writeFile(join(themeRepoPath, 'README.md'), '# theme');
    await mkdir(join(themeRepoPath, 'editions'), { recursive: true });
    await writeFile(join(themeRepoPath, 'editions', 'placeholder.html'), '<!-- placeholder -->');
    await mkdir(join(themeRepoPath, 'src'), { recursive: true });
    await writeFile(join(themeRepoPath, 'src', 'page.tsx'), 'export default () => null;');

    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: themeRepoPath, stdio: 'ignore' });
    };
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '.');
    git('commit', '-m', 'initial');
  });

  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('overlays every theme file when no subdir is set', async () => {
    const files = new Map<string, Buffer | string>();
    const result = await applyThemeOverlay(
      { url: themeRepoPath, ref: 'main' },
      files,
    );
    expect(result.filesOverlaid).toBeGreaterThanOrEqual(4);
    expect(result.clonedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(files.get('package.json')?.toString()).toBe('{"name":"theme"}');
    expect(files.get('README.md')?.toString()).toBe('# theme');
    expect(files.get('src/page.tsx')?.toString()).toContain('export default');
    expect(files.get('editions/placeholder.html')?.toString()).toContain('placeholder');
  });

  it('honours subdir and strips the prefix from emitted paths', async () => {
    const files = new Map<string, Buffer | string>();
    const result = await applyThemeOverlay(
      { url: themeRepoPath, ref: 'main', subdir: 'src' },
      files,
    );
    expect(result.filesOverlaid).toBe(1);
    expect(files.has('page.tsx')).toBe(true);
    // Files outside the subdir must NOT be emitted at all.
    expect(files.has('package.json')).toBe(false);
    expect(files.has('README.md')).toBe(false);
  });

  it('throws theme_subdir_missing when subdir does not exist', async () => {
    const files = new Map<string, Buffer | string>();
    await expect(
      applyThemeOverlay({ url: themeRepoPath, ref: 'main', subdir: 'does-not-exist' }, files),
    ).rejects.toThrow(/theme_subdir_missing/);
  });

  it('does NOT clobber pre-seeded entries in the file map', async () => {
    const files = new Map<string, Buffer | string>();
    // Caller pre-seeds a platform-emitted path. Overlay should leave it.
    files.set('editions/placeholder.html', 'PLATFORM_WINS');
    await applyThemeOverlay({ url: themeRepoPath, ref: 'main' }, files);
    expect(files.get('editions/placeholder.html')).toBe('PLATFORM_WINS');
  });

  it('throws theme_clone_failed on a bad ref', async () => {
    const files = new Map<string, Buffer | string>();
    await expect(
      applyThemeOverlay({ url: themeRepoPath, ref: 'no-such-branch' }, files),
    ).rejects.toThrow(/theme_clone_failed/);
  });
});
