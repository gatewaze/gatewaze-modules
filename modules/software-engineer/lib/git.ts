// @ts-nocheck
/**
 * Minimal SAFE git wrapper. Uses execFile with an argv ARRAY (never a shell string,
 * never shell:true) — so branch names / repo paths can't inject shell metacharacters.
 * This mirrors the philosophy of packages/api/src/lib/safe-exec.ts; module code can't
 * import that host file, so we keep an equivalent local wrapper.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export async function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const { stdout } = await pexec('git', args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

/**
 * Authenticated HTTPS remote. `x-access-token` works for both classic/fine-grained PATs
 * and GitHub App installation tokens. NOTE: the token appears in the argv here; callers
 * MUST scrub it from any error surfaced to logs/UI (see redactToken).
 */
export function authedRemote(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

/** Scrub a token from an error message before it is logged or shown. */
export function redactToken(message: string, token?: string): string {
  return redactSecrets(message, [token]);
}

/**
 * Scrub EVERY live secret for a run from an error string before it is persisted or shown — the
 * GitHub PAT, the model credential, and any MCP bearer/header token. The Agent SDK collapses a
 * subprocess failure into raw stderr (agent-session appends it to result.error), which may echo an
 * auth header or a tokenised git remote; redacting only the PAT would leak the rest.
 */
export function redactSecrets(message: string, secrets: (string | null | undefined)[]): string {
  let out = message ?? '';
  // Longest-first so a token that contains another as a substring is fully masked.
  for (const s of [...new Set(secrets)].filter((v): v is string => !!v && v.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***');
  }
  return out.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}
