/**
 * Theme overlay — clone a site's theme repo at a pinned ref and inject
 * its file tree into the publish-commit file map so the resulting publish
 * branch is a self-contained, buildable artifact (Netlify / GH Pages can
 * point straight at it).
 *
 * Activated when `sites.config.theme = { url, ref, subdir? }` is set.
 * The platform-emitted files are written into the map AFTER the theme
 * overlay so they take precedence on collision (e.g. theme ships an
 * app/page.tsx stub; the platform overwrites it with the routes it
 * generated from pages.full_path).
 *
 * Auth: HTTPS clone with the GITHUB_TOKEN env var when present (matches
 * the token used for graduate-to-external). SSH / per-site deploy-key
 * auth is out of scope for v1 — themes are expected to be either public
 * or accessible to the platform PAT.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

export interface ThemeConfig {
  /** HTTPS URL of the theme git repo. */
  url: string;
  /** Branch, tag, or commit SHA to clone. */
  ref: string;
  /**
   * Optional subdirectory within the theme repo. When set, only files
   * under this subdir are overlaid, and the subdir prefix is stripped
   * from the published path (so `frontend/package.json` becomes
   * `package.json` at the publish root).
   */
  subdir?: string;
}

export interface ApplyThemeOverlayOpts {
  /** Read from process.env.GITHUB_TOKEN unless overridden. */
  githubToken?: string;
  /** Inject for tests; defaults to spawn. */
  spawnFn?: typeof spawn;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface GitExecResult { exitCode: number; stdout: string; stderr: string }

function execGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; spawnFn?: typeof spawn } = {}): Promise<GitExecResult> {
  const fn = opts.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const proc = fn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * Inject a token into an https github URL: turns
 * `https://github.com/org/repo.git` into
 * `https://x-access-token:<token>@github.com/org/repo.git`. Leaves
 * non-github / non-https URLs unchanged so SSH URLs (`git@github.com:...`)
 * fall through to the user's ssh-agent / known deploy key.
 */
export function injectTokenInUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  if (!url.startsWith('https://')) return url;
  if (url.includes('@')) return url; // already has credentials
  return url.replace('https://', `https://x-access-token:${token}@`);
}

/**
 * Recursively walk a directory, returning [relativePath, Buffer] pairs.
 * Excludes .git so we don't carry the theme's git history through to
 * the publish repo. Other dotfiles ARE included — themes may need
 * `.github/workflows/`, `.gitignore`, `.npmrc` etc. to ship.
 */
async function walkFiles(rootDir: string): Promise<Array<[string, Buffer]>> {
  const out: Array<[string, Buffer]> = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const buf = await readFile(full);
        out.push([relative(rootDir, full), buf]);
      }
    }
  }
  await visit(rootDir);
  return out;
}

/**
 * Clone the theme at the pinned ref, walk its file tree (optionally
 * narrowed to `subdir`), and write each file into `out` under a
 * subdir-stripped path. Existing entries in `out` are preserved —
 * callers should add platform-emitted overrides AFTER this runs.
 *
 * Caller-supplied `out` is mutated for symmetry with the rest of the
 * buildSiteContentFiles flow. Returns the count of files overlaid so
 * the caller can log it.
 */
export async function applyThemeOverlay(
  theme: ThemeConfig,
  out: Map<string, Buffer | string>,
  opts: ApplyThemeOverlayOpts = {},
): Promise<{ filesOverlaid: number; clonedSha: string }> {
  const logger = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
  };
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN ?? undefined;
  const cloneUrl = injectTokenInUrl(theme.url, token);

  const tmpDir = await mkdtemp(join(tmpdir(), 'gatewaze-theme-overlay-'));
  try {
    // --depth 1 is fine: we don't need history, only the ref's tree.
    // Cloning a tag/sha requires --branch + the unshallow dance for SHAs;
    // for branches/tags --depth 1 --branch works directly. Operators
    // pinning to a SHA should tag the SHA first.
    const clone = await execGit(
      ['clone', '--depth', '1', '--branch', theme.ref, cloneUrl, tmpDir],
      { spawnFn: opts.spawnFn },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`theme_clone_failed: ${clone.stderr.trim()}`);
    }
    const rev = await execGit(['rev-parse', 'HEAD'], { cwd: tmpDir, spawnFn: opts.spawnFn });
    const clonedSha = rev.stdout.trim();

    const treeRoot = theme.subdir ? join(tmpDir, theme.subdir) : tmpDir;
    // Verify subdir exists before walking — typos in config should fail
    // loudly rather than silently overlay nothing.
    if (theme.subdir) {
      try {
        const s = await stat(treeRoot);
        if (!s.isDirectory()) {
          throw new Error(`theme_subdir_not_a_directory: ${theme.subdir}`);
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          throw new Error(`theme_subdir_missing: ${theme.subdir} not found at ${theme.url}@${theme.ref}`);
        }
        throw err;
      }
    }

    const files = await walkFiles(treeRoot);
    for (const [relPath, buf] of files) {
      // Don't clobber platform-emitted files added before us — but in the
      // intended call order (overlay first, platform after), the Map is
      // initially empty on this code path, so this is a defensive check
      // for callers that pre-seed `out` with overrides.
      if (!out.has(relPath)) {
        out.set(relPath, buf);
      }
    }

    logger.info('theme overlay applied', {
      url: theme.url,
      ref: theme.ref,
      subdir: theme.subdir,
      filesOverlaid: files.length,
      clonedSha,
    });

    return { filesOverlaid: files.length, clonedSha };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
