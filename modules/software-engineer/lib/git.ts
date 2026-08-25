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
 * Branch name for a run. LFX repos use a Jira-linked human convention —
 * feat/LFXV2-1234-short-slug — derived from a "[LFXV2-1234] Title" issue
 * title. Our own agent/se-<issue>-<hash> pattern sitting next to those on a
 * public repo's PR list is a visible tell that the branch was agent-authored
 * (confidentiality gap flagged 2026-08-25), so match the human convention
 * whenever the issue carries a ticket ref. Gatewaze issue titles never start
 * with a bracketed ticket ref, so checking for the ref alone is enough to
 * scope this correctly — no separate "is this an LFX project" check needed,
 * and nothing here is LFX-specific beyond the shape of the ref itself.
 *
 * Deliberately excludes anything identifying WHICH agent/model/run authored
 * it beyond the issue number, which is already public on the issue.
 */
const TICKET_REF = /^\s*\[([A-Z][A-Z0-9]{1,14}-\d{1,8})\]/;

function slugifyTitle(title: string, maxWords = 6): string {
  return title
    .replace(TICKET_REF, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-');
}

export function branchNameFor(run: { issue_number: number; id: string }, issueTitle?: string | null): string {
  const fallback = `agent/se-${run.issue_number}-${String(run.id).slice(0, 8)}`;
  const ticket = issueTitle?.match(TICKET_REF)?.[1];
  if (!ticket) return fallback;
  const slug = slugifyTitle(issueTitle);
  const branch = `feat/${ticket}${slug ? `-${slug}` : ''}`;
  // Sanity bound — a pathological title (e.g. no word chars after the ref)
  // shouldn't ever produce something git rejects or an empty/odd-looking ref.
  return branch.length >= 6 && branch.length <= 80 ? branch : fallback;
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
