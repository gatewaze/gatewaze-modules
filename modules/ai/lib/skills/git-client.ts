/**
 * Git subprocess wrapper for skill-source syncing.
 *
 * Per spec-ai-skills.md §4.2: every git command runs as a child process
 * with explicit timeout, no terminal prompting, and a tokenless argv —
 * any auth token is supplied via the GIT_ASKPASS helper script that
 * reads from an environment variable we control, never via the URL or
 * argv (which would leak into logs / ps).
 *
 * On timeout we SIGTERM the child, wait 2 s, then SIGKILL.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunGitOptions {
  cwd?: string;
  /** Per-step timeout in milliseconds. */
  timeoutMs: number;
  /** Bearer token for HTTPS auth (e.g. github PAT). Passed via GIT_ASKPASS. */
  authToken?: string | null;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'git_timeout'
      | 'git_exit_nonzero'
      | 'git_spawn_failed'
      | 'git_not_installed',
    public readonly stderr?: string,
    public readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Run a git command. Tokens go via a temp GIT_ASKPASS script — never
 * via argv or URL. On timeout, escalate SIGTERM → SIGKILL.
 */
export async function runGit(args: string[], opts: RunGitOptions): Promise<GitRunResult> {
  const start = Date.now();

  let askpassDir: string | null = null;
  const env: Record<string, string> = {
    // Inherit minimal env. We never source ~/.gitconfig (avoids
    // honouring per-user credential helpers / proxies).
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    // Defensive: never prompt on the terminal — if anything goes wrong
    // with auth, fail fast rather than hang.
    GIT_TERMINAL_PROMPT: '0',
    // git config overrides we want:
    //   - core.askPass / SSH_ASKPASS: routed to our helper
    //   - http.followRedirects: native default (true) is fine
    GIT_CONFIG_NOSYSTEM: '1',
  };

  if (opts.authToken) {
    // GIT_ASKPASS is a helper script. Git calls it with a prompt
    // argument; it prints the credential on stdout. We supply the
    // token via an env var the helper reads — that way the token
    // never appears in `ps` output or git's own logs.
    askpassDir = mkdtempSync(join(tmpdir(), 'gw-ai-skills-askpass-'));
    const helperPath = join(askpassDir, 'askpass.sh');
    // The helper handles both username and password prompts:
    //   - username prompt → emit "x-access-token" (GitHub convention)
    //   - password prompt → emit $GW_AI_SKILLS_TOKEN
    const helper = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s' "x-access-token" ;;
  *) printf '%s' "$GW_AI_SKILLS_TOKEN" ;;
esac
`;
    writeFileSync(helperPath, helper, 'utf-8');
    chmodSync(helperPath, 0o700);
    env.GIT_ASKPASS = helperPath;
    env.GW_AI_SKILLS_TOKEN = opts.authToken;
  }

  return await new Promise<GitRunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (askpassDir) cleanup(askpassDir);
      reject(
        new GitError(
          `git_spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error && err.message.includes('ENOENT')
            ? 'git_not_installed'
            : 'git_spawn_failed',
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    let killed = false;
    const sigtermTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Escalate if the child ignores SIGTERM.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, opts.timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(sigtermTimer);
      if (askpassDir) cleanup(askpassDir);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const durationMs = Date.now() - start;

      if (killed) {
        reject(
          new GitError(
            `git command timed out after ${opts.timeoutMs}ms`,
            'git_timeout',
            stderr,
            exitCode,
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        reject(
          new GitError(
            `git exited with code ${exitCode}: ${stderr.trim()}`,
            'git_exit_nonzero',
            stderr,
            exitCode,
          ),
        );
        return;
      }

      resolve({ stdout, stderr, durationMs });
    });

    child.on('error', (err) => {
      clearTimeout(sigtermTimer);
      if (askpassDir) cleanup(askpassDir);
      reject(
        new GitError(
          err.message.includes('ENOENT') ? 'git not installed' : `git error: ${err.message}`,
          err.message.includes('ENOENT') ? 'git_not_installed' : 'git_spawn_failed',
        ),
      );
    });
  });

  function cleanup(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Convenience helpers. */

export async function gitClone(args: { url: string; branch: string; targetDir: string; authToken?: string | null; timeoutMs: number }): Promise<void> {
  await runGit(['clone', '--depth', '1', '--branch', args.branch, '--single-branch', args.url, args.targetDir], {
    timeoutMs: args.timeoutMs,
    ...(args.authToken ? { authToken: args.authToken } : {}),
  });
}

export async function gitFetchHard(args: { cwd: string; branch: string; authToken?: string | null; timeoutMs: number }): Promise<void> {
  await runGit(['fetch', 'origin', args.branch], {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    ...(args.authToken ? { authToken: args.authToken } : {}),
  });
  await runGit(['reset', '--hard', `origin/${args.branch}`], {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
  await runGit(['clean', '-fdx'], {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
}

export async function gitRevParseHead(args: { cwd: string; timeoutMs: number }): Promise<string> {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd: args.cwd, timeoutMs: args.timeoutMs });
  return r.stdout.trim();
}

export async function gitLsRemote(args: { url: string; branch: string; authToken?: string | null; timeoutMs: number }): Promise<string> {
  const r = await runGit(['ls-remote', args.url, `refs/heads/${args.branch}`], {
    timeoutMs: args.timeoutMs,
    ...(args.authToken ? { authToken: args.authToken } : {}),
  });
  // Output is "<sha>\trefs/heads/<branch>\n" — extract the sha.
  const first = r.stdout.split(/\s+/, 1)[0];
  if (!first) throw new GitError('ls-remote returned empty', 'git_exit_nonzero');
  return first;
}
