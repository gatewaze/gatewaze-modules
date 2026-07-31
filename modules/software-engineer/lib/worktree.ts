// @ts-nocheck
/**
 * Worktree helpers. Each repo-touching phase clones the AGENT BRANCH fresh (state lives in the
 * pushed git branch, not local disk) so the pipeline survives the multi-pod runner pool — phase
 * N and N+1 may land on different pods. Shallow clones keep it cheap.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, authedRemote } from './git.js';

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
}

/**
 * Multi-repo workspace (§7): clone each of the project's code repos into `<root>/<repoName>/`. Writable
 * repos get a fresh `branch` cut off their base branch (default branch if unset) + the commit
 * identity; read-only repos are cloned for context only. The agent's cwd is the workspace root and it
 * reads across all subdirs but changes only writable ones.
 */
export async function makeMultiWorkspace(
  codeRepos: Array<{ repoOwner: string; repoName: string; writeMode: 'writable' | 'read_only'; baseBranch: string | null }>,
  token: string,
  branch: string,
  id?: CommitIdentity,
  existing?: boolean,   // when true, writable repos clone the EXISTING run branch (revise) instead of cutting a new one
): Promise<{ root: string; repos: WsRepo[]; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'se-ws-'));
  const repos: WsRepo[] = [];
  try {
    for (const r of codeRepos) {
      const dir = join(root, r.repoName);
      const remote = authedRemote(r.repoOwner, r.repoName, token);
      const writable = r.writeMode === 'writable';
      if (writable && existing) {
        await git(['clone', '--depth', '1', '--branch', branch, remote, dir]); // the run branch already exists
        await identity(dir, id);
      } else {
        if (r.baseBranch) await git(['clone', '--depth', '1', '--branch', r.baseBranch, remote, dir]);
        else await git(['clone', '--depth', '1', remote, dir]);
        if (writable) { await git(['-C', dir, 'checkout', '-b', branch]); await identity(dir, id); }
      }
      repos.push({ repoOwner: r.repoOwner, repoName: r.repoName, dir, writable, baseBranch: r.baseBranch });
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
  await git(['-C', repoDir, 'commit', '-m', message, '--no-verify']);
  await git(['-C', repoDir, 'push', '-u', 'origin', branch]);
}
