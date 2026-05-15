/**
 * Newsletter theme overlay — clone a theme repo at a pinned ref and
 * inject its file tree into the publish-commit file map so the
 * resulting publish branch is a self-contained, buildable artifact
 * (a static-site generator pointed at the publish repo can render the
 * archive page; a Next.js theme can render per-edition pages from the
 * `editions/*.json` files we emit).
 *
 * Activated when the newsletter collection has
 * `config.theme = { url, ref, subdir? }` set. The platform-emitted
 * files (`editions/<id>.html` + `editions/<id>.json`) are written into
 * the map AFTER the theme overlay so they take precedence on collision.
 *
 * Mirrors `modules/sites/lib/publish-worker/theme-overlay.ts` — the
 * algorithm and shape are intentionally identical. Inlined here rather
 * than imported across modules because newsletters does not depend on
 * the sites package.
 *
 * Auth: HTTPS clone uses `process.env.GITHUB_TOKEN` when present (the
 * same convention as the sites overlay). For private theme repos that
 * require a per-newsletter deploy key, pass the key via
 * `themeDeployKey` so the clone shells out to ssh with that identity.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

export interface ThemeConfig {
  /** Theme git repo URL (HTTPS or SSH). */
  url: string;
  /** Branch, tag, or commit SHA to clone. */
  ref: string;
  /**
   * Optional subdirectory within the theme repo. When set, only files
   * under this subdir are overlaid, and the subdir prefix is stripped
   * from the published path.
   */
  subdir?: string;
}

export interface ApplyThemeOverlayOpts {
  /** Defaults to process.env.GITHUB_TOKEN when omitted. */
  githubToken?: string;
  /**
   * PEM-encoded OpenSSH private key. When provided, the clone goes via
   * SSH using this key (and the URL is rewritten to SSH form by the
   * caller). Useful when the theme repo is private and accessible only
   * to the platform's deploy key.
   */
  themeDeployKey?: string;
  /** Inject for tests; defaults to spawn. */
  spawnFn?: typeof spawn;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface GitExecResult { exitCode: number; stdout: string; stderr: string }

function execGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; spawnFn?: typeof spawn } = {},
): Promise<GitExecResult> {
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
 * Inject a token into an https github URL:
 *   `https://github.com/org/repo.git`
 *     -> `https://x-access-token:<token>@github.com/org/repo.git`
 * Leaves non-https URLs unchanged.
 */
export function injectTokenInUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  if (!url.startsWith('https://')) return url;
  if (url.includes('@')) return url;
  return url.replace('https://', `https://x-access-token:${token}@`);
}

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

export async function applyThemeOverlay(
  theme: ThemeConfig,
  out: Map<string, Buffer | string>,
  opts: ApplyThemeOverlayOpts = {},
): Promise<{ filesOverlaid: number; clonedSha: string }> {
  const logger = opts.logger ?? { info: () => undefined, warn: () => undefined };
  const tmpDir = await mkdtemp(join(tmpdir(), 'gatewaze-newsletter-theme-overlay-'));
  try {
    let env: Record<string, string> | undefined;
    let cloneUrl = theme.url;

    if (opts.themeDeployKey) {
      // SSH-with-deploy-key path: write the key out, point GIT_SSH_COMMAND at it.
      const keyPath = join(tmpDir, '.deploy_key');
      await writeFile(keyPath, opts.themeDeployKey, { mode: 0o600 });
      env = {
        GIT_SSH_COMMAND:
          `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`,
      };
    } else {
      const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
      cloneUrl = injectTokenInUrl(theme.url, token);
    }

    const cloneDir = join(tmpDir, 'theme');
    const clone = await execGit(
      ['clone', '--depth', '1', '--branch', theme.ref, cloneUrl, cloneDir],
      { spawnFn: opts.spawnFn, env },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`theme_clone_failed: ${clone.stderr.trim()}`);
    }

    const rev = await execGit(['rev-parse', 'HEAD'], { cwd: cloneDir, spawnFn: opts.spawnFn });
    const clonedSha = rev.stdout.trim();

    const treeRoot = theme.subdir ? join(cloneDir, theme.subdir) : cloneDir;
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
      if (!out.has(relPath)) {
        out.set(relPath, buf);
      }
    }

    logger.info('newsletter theme overlay applied', {
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
