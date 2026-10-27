// @ts-nocheck
/**
 * Worktree helpers. Each repo-touching phase clones the AGENT BRANCH fresh (state lives in the
 * pushed git branch, not local disk) so the pipeline survives the multi-pod runner pool — phase
 * N and N+1 may land on different pods. Shallow clones keep it cheap.
 */
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, gitRaw, authedRemote } from './git.js';

// A single owner/name segment safe to use as a path component AND in a git remote URL: the same
// charset github.ts validates owner/name with, but per-segment and with '.'/'..' explicitly rejected
// (both pass the charset yet are path-traversal).
const safeSegment = (s: string): boolean =>
  typeof s === 'string' && /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..';

export async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'se-'));
  return {
    root,
    repoDir: join(root, 'repo'),
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}),
  };
}

export interface CommitIdentity {
  name?: string | null;
  email?: string | null;
}

// Neutral fallback when a brand hasn't configured its own commit identity. A brand SHOULD set
// commit_author_name / commit_author_email (its own GitHub user's name + noreply email) so pushed
// commits are attributed to that account.
const DEFAULT_IDENTITY: Required<CommitIdentity> = {
  name: 'Gatewaze Bot',
  email: 'bot@users.noreply.github.com',
};

async function identity(repoDir: string, id?: CommitIdentity) {
  const name = id?.name?.trim() || DEFAULT_IDENTITY.name;
  const email = id?.email?.trim() || DEFAULT_IDENTITY.email;
  await git(['-C', repoDir, 'config', 'user.name', name]);
  await git(['-C', repoDir, 'config', 'user.email', email]);
}

/** Clone an existing branch (review / implement / verify work on the agent branch). */
export async function cloneBranch(repoDir: string, run: any, token: string, branch: string, id?: CommitIdentity) {
  await git(['clone', '--depth', '1', '--branch', branch, authedRemote(run.repo_owner, run.repo_name, token), repoDir]);
  await identity(repoDir, id);
}

/** Clone `fromBranch` and cut a new branch off it (spec creates the agent branch off base). */
export async function cloneNewBranch(repoDir: string, run: any, token: string, fromBranch: string, newBranch: string, id?: CommitIdentity) {
  await git(['clone', '--depth', '1', '--branch', fromBranch, authedRemote(run.repo_owner, run.repo_name, token), repoDir]);
  await git(['-C', repoDir, 'checkout', '-b', newBranch]);
  await identity(repoDir, id);
}

export interface WsRepo {
  repoOwner: string;
  repoName: string;
  dir: string;
  writable: boolean;
  baseBranch: string | null;
  startSha: string | null; // HEAD right after clone, before the agent runs; null for read-only repos
  /** Where to read the working agreement + skills from when NOT the checkout itself — the pre-PR
   *  review phase points this at the base branch's guardrails when the branch changed them. */
  agreementDir?: string;
}

/**
 * Multi-repo workspace (§7): clone each of the project's code repos into `<root>/<repoOwner>/<repoName>/`. Writable
 * repos get a fresh `branch` cut off their base branch (default branch if unset) + the commit
 * identity; read-only repos are cloned for context only. The agent's cwd is the workspace root and it
 * reads across all subdirs but changes only writable ones.
 */
export async function makeMultiWorkspace(
  codeRepos: Array<{ repoOwner: string; repoName: string; writeMode: 'writable' | 'read_only'; baseBranch: string | null; checkoutRef?: string }>,
  token: string,
  branch: string,
  id?: CommitIdentity,
  existing?: boolean,   // when true, writable repos clone the EXISTING run branch (revise) instead of cutting a new one
): Promise<{ root: string; repos: WsRepo[]; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'se-ws-'));
  const repos: WsRepo[] = [];
  try {
    for (const r of codeRepos) {
      const writable = r.writeMode === 'writable';
      // repo_owner/repo_name feed a filesystem path (join, below) AND a destructive rm on clone
      // failure — an unsafe segment ('..', a slash, a shell/URL metachar) must never escape the
      // workspace root. Validate before building any path or running git. Reject a writable target
      // outright (the run can't proceed); silently drop an invalid read-only reference repo.
      if (!safeSegment(r.repoOwner) || !safeSegment(r.repoName)) {
        if (writable) throw new Error(`unsafe repo identity: ${r.repoOwner}/${r.repoName}`);
        continue;
      }
      const ownerDir = join(root, r.repoOwner);
      await mkdir(ownerDir, { recursive: true });
      const dir = join(ownerDir, r.repoName);
      const remote = authedRemote(r.repoOwner, r.repoName, token);
      try {
        if (writable && existing) {
          await git(['clone', '--depth', '1', '--branch', branch, remote, dir]); // the run branch already exists
          await identity(dir, id);
        } else {
          const ref = r.baseBranch === 'main' ? r.checkoutRef ?? r.baseBranch : r.baseBranch;
          if (ref) await git(['clone', '--depth', '1', '--branch', ref, remote, dir]);
          else await git(['clone', '--depth', '1', remote, dir]);
          if (r.checkoutRef && r.baseBranch === 'main') {
            const expected = r.checkoutRef.split('/').at(-1);
            if ((await git(['-C', dir, 'rev-parse', 'HEAD'])).trim() !== expected) throw new Error('HELF preview reference changed');
          }
          if (writable) { await git(['-C', dir, 'checkout', '-b', branch]); await identity(dir, id); }
        }
      } catch (e) {
        // A WRITABLE repo is an edit target — if it won't clone the run can't proceed, so fail.
        if (writable || r.checkoutRef) throw e;
        // A READ-ONLY repo is reference context (e.g. a private cross-project repo the token may not
        // reach). Never let it fail the whole run — drop it, keep going without that context.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      // Captured right after clone (+ checkout -b for the fresh-branch case), so HEAD is exactly
      // the commit the agent starts editing from — the boundary `commitsAhead` diffs against to
      // detect a self-committing agent, regardless of which clone mode ran above.
      const startSha = writable ? (await git(['-C', dir, 'rev-parse', 'HEAD'])).trim() : null;
      repos.push({ repoOwner: r.repoOwner, repoName: r.repoName, dir, writable, baseBranch: r.baseBranch, startSha });
    }
    return { root, repos, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}) };
  } catch (e) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export async function hasChanges(repoDir: string): Promise<boolean> {
  return (await git(['-C', repoDir, 'status', '--porcelain'])).trim().length > 0;
}

export async function commitAndPush(repoDir: string, branch: string, message: string) {
  await git(['-C', repoDir, 'add', '-A']);
  // --no-verify: shallow clone has no hooks installed; this is the worker's commit, not the
  // agent's (the agent is separately barred from --no-verify by the PreToolUse hook).
  // -s: DCO Signed-off-by from the configured commit identity — LF repos reject unsigned commits.
  await git(['-C', repoDir, 'commit', '-s', '-m', message, '--no-verify']);
  await git(['-C', repoDir, 'push', '-u', 'origin', branch]);
}

/** Commits made on HEAD since `startSha` — non-zero means the agent ran `git commit` itself. */
export async function commitsAhead(repoDir: string, startSha: string | null): Promise<number> {
  if (!startSha) return 0;
  const out = await git(['-C', repoDir, 'rev-list', '--count', `${startSha}..HEAD`]);
  return parseInt(out.trim(), 10) || 0;
}

/** Push only — for the case where the agent already committed and the tree is clean. */
export async function pushBranch(repoDir: string, branch: string) {
  await git(['-C', repoDir, 'push', '-u', 'origin', branch]);
}

// A ref name that is safe as a git argv value: the fetch below passes it inside a refspec, and a
// leading '-' would turn it into an option.
const safeRef = (s: string): boolean => typeof s === 'string' && /^[A-Za-z0-9_./-]+$/.test(s) && !s.startsWith('-') && !s.includes('..');

/**
 * Give a shallow, single-branch clone of the run branch (makeMultiWorkspace with `existing`) the
 * history a branch review needs: the base branch under `refs/remotes/origin/<base>` and enough depth
 * on both sides for `git merge-base origin/<base> HEAD` to resolve. The run branch was cut from the
 * base tip, so a bounded deepen normally joins them; an unshallow is the last resort. Returns the
 * merge base, or null when history still could not be joined — the caller tells the agent, it never
 * blocks the phase on its own.
 */
export async function fetchBaseForReview(repoDir: string, baseBranch: string, branch: string, depth = 200): Promise<string | null> {
  if (!safeRef(baseBranch) || !safeRef(branch)) return null;
  const mergeBase = async () => (await git(['-C', repoDir, 'merge-base', `origin/${baseBranch}`, 'HEAD'])).trim() || null;
  // A base that cannot be fetched at all (no such branch, auth) is the caller's to report: this throws.
  await git(['-C', repoDir, 'fetch', '--depth', String(depth), 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
  // Each step below may legitimately fail (a clone that is already complete, histories still
  // disjoint); only the final merge-base answer matters, so every failure falls through to the next.
  try { await git(['-C', repoDir, 'fetch', `--deepen=${depth}`, 'origin', branch]); } catch { /* fall through */ }
  try { return await mergeBase(); } catch { /* fall through */ }
  try { await git(['-C', repoDir, 'fetch', '--unshallow', 'origin', baseBranch, branch]); } catch { /* fall through */ }
  try { return await mergeBase(); } catch { return null; }
}

/**
 * The paths that steer an agent's work on a repo: its working agreement, rules and skills. The
 * pre-PR review phase must not take these from the branch it is reviewing (the implement agent wrote
 * that branch from issue text), so it checks whether the branch changed them and, if so, reads the
 * base branch's versions instead.
 */
export const GUARDRAIL_PATHS = ['CLAUDE.md', 'AGENTS.md', '.claude/rules', '.claude/skills'];

/**
 * Paths that commonly carry the checks a working agreement tells the agent to run (build, lint,
 * test scripts, CI). They always run from the branch under review — there is no base-branch
 * substitute for a repo's own tooling — so a branch change to them is surfaced to the reviewer and
 * recorded on the gate rather than silently trusted. Best-effort list; the residual risk stands.
 */
export const TOOLING_PATHS = ['Makefile', 'package.json', 'scripts', 'tools', 'bin', '.github', '.githooks', 'Taskfile.yml', 'justfile'];

/** Paths under `paths` that differ between `from` and HEAD, NUL-separated from git so a name can
 *  never be mis-split. Empty when the branch left them alone. */
export async function changedPaths(repoDir: string, from: string, paths: string[]): Promise<string[]> {
  const out = await git(['-C', repoDir, 'diff', '--name-only', '-z', from, 'HEAD', '--', ...paths]);
  return out.split('\0').filter(Boolean);
}

/** Guardrail paths the branch changed between `from` and HEAD. */
export const changedGuardrails = (repoDir: string, from: string) => changedPaths(repoDir, from, GUARDRAIL_PATHS);

/**
 * Write the guardrail paths as they are at `ref` under `dest` (same relative layout), so they can be
 * read as a working agreement and skills directory in place of the branch's. Regular blobs only,
 * bytes copied raw with the executable bit kept; symlinks (mode 120000) and gitlinks (160000) are
 * skipped — a link target written as a file would be injected as the agreement's text, and a
 * submodule has no blob to read. Paths come from git's own NUL-separated tree listing and are
 * git-normalised (relative, no `..`). Returns the number of files written.
 */
export async function exportGuardrailsAtRef(repoDir: string, ref: string, dest: string): Promise<number> {
  const listing = await git(['-C', repoDir, 'ls-tree', '-r', '-z', ref, '--', ...GUARDRAIL_PATHS]);
  let n = 0;
  for (const entry of listing.split('\0').filter(Boolean)) {
    // "<mode> <type> <sha>\t<path>"
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    const p = entry.slice(tab + 1);
    if (type !== 'blob' || mode === '120000' || !p) continue;
    const content = await gitRaw(['-C', repoDir, 'cat-file', 'blob', sha]);
    const target = join(dest, p);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    if (mode === '100755') await chmod(target, 0o755);
    n++;
  }
  return n;
}

/**
 * Commit only TRACKED changes (modified/deleted files the agent edited but did not commit) and push.
 * Untracked files are left out and returned: a review phase runs builds, tests and preflight
 * scripts, so a dirty tree there is far more likely to hold generated output than a forgotten fix.
 * Returns whether a commit was made and the untracked paths that were skipped.
 */
export async function commitTrackedAndPush(repoDir: string, branch: string, message: string): Promise<{ committed: boolean; untracked: string[] }> {
  const untracked = (await git(['-C', repoDir, 'ls-files', '--others', '--exclude-standard'])).split('\n').map((s) => s.trim()).filter(Boolean);
  await git(['-C', repoDir, 'add', '-u']);
  const staged = (await git(['-C', repoDir, 'diff', '--cached', '--name-only'])).trim().length > 0;
  if (staged) {
    // --no-verify + -s: same reasons as commitAndPush (no hooks in the shallow clone; DCO sign-off).
    await git(['-C', repoDir, 'commit', '-s', '-m', message, '--no-verify']);
  }
  await git(['-C', repoDir, 'push', '-u', 'origin', branch]);
  return { committed: staged, untracked };
}
