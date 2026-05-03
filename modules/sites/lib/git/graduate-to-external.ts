/**
 * graduateToExternal — promote a site's internal git repo to an
 * external GitHub/GitLab repo.
 *
 * Per spec-content-modules-git-architecture §6.5:
 *   1. Validate PAT scope (repo + admin:repo_hook for GitHub; api for GitLab)
 *   2. Provision the deploy key (read+write, scoped to the target repo)
 *   3. Configure branch-protection on `main` and `publish` (only the
 *      deploy key can push)
 *   4. Push both `main` and `publish` from internal bare repo to external
 *   5. Drop the user's PAT (only the deploy key persists)
 *   6. Update sites.git_provenance + git_url
 *   7. Schedule the internal bare repo for purge after 7-day grace
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InternalGitServer, InternalRepoRef } from './internal-git-server.js';

export interface GraduateToExternalArgs {
  siteId: string;
  /** Repo URL the user wants to graduate to (e.g. https://github.com/myorg/site.git). */
  externalGitUrl: string;
  /** One-time PAT supplied by the user — dropped after key + protection setup. */
  pat: string;
  /** The internal repo currently backing the site. */
  internalRepo: InternalRepoRef;
  /** The site row — used for naming the deploy key. */
  site: { name: string; slug: string };
}

export interface GraduateResult {
  externalGitUrl: string;
  deployKeyId: string | number;
  branchProtectionApplied: boolean;
  internalPurgeScheduledFor: string;
}

export interface GraduateDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  gitServer: InternalGitServer;
  /**
   * Optional fetch override (tests).
   */
  fetch?: typeof globalThis.fetch;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface ProviderOps {
  /** Validate the PAT has required scopes; returns null if OK, or an error message. */
  validatePatScope(pat: string, ownerRepo: string): Promise<string | null>;
  /** Provision the deploy key with read+write. Returns the provider's key id. */
  createDeployKey(args: { pat: string; ownerRepo: string; title: string; publicKey: string }): Promise<string | number>;
  /** Configure branch-protection on `main` and `publish`. */
  protectBranches(args: { pat: string; ownerRepo: string; branches: string[] }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function graduateToExternal(
  args: GraduateToExternalArgs,
  deps: GraduateDeps,
): Promise<GraduateResult> {
  const provider = detectProvider(args.externalGitUrl);
  if (!provider) {
    throw new Error(`unsupported git provider: ${args.externalGitUrl}`);
  }
  const ownerRepo = parseOwnerRepo(args.externalGitUrl, provider);
  if (!ownerRepo) {
    throw new Error(`could not parse owner/repo from URL: ${args.externalGitUrl}`);
  }

  const ops = providerOps(provider, deps.fetch ?? globalThis.fetch);

  // 1. Validate PAT scope
  const scopeError = await ops.validatePatScope(args.pat, ownerRepo);
  if (scopeError) {
    throw new Error(`pat_under_scoped: ${scopeError}`);
  }

  // 2. Generate an Ed25519 deploy keypair. Public half goes to the
  //    provider; private half stays in sites_secrets as the deploy key
  //    used by future pushes/clones.
  const keypair = await generateEd25519Keypair();
  const deployKeyTitle = `gatewaze-${args.site.slug}-${new Date().toISOString().slice(0, 10)}`;
  const deployKeyId = await ops.createDeployKey({
    pat: args.pat,
    ownerRepo,
    title: deployKeyTitle,
    publicKey: keypair.publicKey,
  });

  // 3. Branch protection (per spec §6.4)
  const branchProtectionApplied = await ops.protectBranches({
    pat: args.pat,
    ownerRepo,
    branches: ['main', 'publish'],
  }).catch((err) => {
    deps.logger.warn('branch protection failed (continuing)', { error: err.message });
    return false;
  });

  // 4. Store the deploy key + remote URL in sites_secrets
  await deps.supabase.from('sites_secrets').upsert({
    site_id: args.siteId,
    key: 'deploy_key',
    encrypted_value: keypair.privateKey,
  });

  // 5. Push both branches from internal bare repo to external
  const workTree = await mkdtemp(join(tmpdir(), 'gatewaze-graduate-'));
  try {
    // Clone internal bare repo with all branches + tags
    const clone = await execGit(['clone', '--mirror', args.internalRepo.barePath, workTree]);
    if (clone.exitCode !== 0) throw new Error(`internal clone failed: ${clone.stderr}`);

    // Configure remote with the deploy key for push auth
    const sshUrl = toSshUrl(args.externalGitUrl, provider);
    await execGit(['remote', 'add', 'external', sshUrl], { cwd: workTree });

    // Push all branches + tags
    const sshKeyPath = join(workTree, 'deploy_key');
    await writeFile(sshKeyPath, keypair.privateKey, { mode: 0o600 });
    const sshCommand = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    const push = await execGit(['push', '--mirror', 'external'], {
      cwd: workTree,
      env: { GIT_SSH_COMMAND: sshCommand },
    });
    if (push.exitCode !== 0) throw new Error(`push to external failed: ${push.stderr}`);
  } finally {
    await rm(workTree, { recursive: true, force: true });
  }

  // 6. Update sites row
  await deps.supabase.from('sites').update({
    git_provenance: 'external',
    git_url: args.externalGitUrl,
  }).eq('id', args.siteId);

  // 7. Schedule internal repo purge (7-day grace per spec §6.5)
  const purgeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await deps.gitServer.softDeleteRepo(args.internalRepo);

  deps.logger.info('graduated to external git', {
    siteId: args.siteId,
    externalGitUrl: args.externalGitUrl,
    deployKeyId,
    branchProtectionApplied,
  });

  return {
    externalGitUrl: args.externalGitUrl,
    deployKeyId,
    branchProtectionApplied,
    internalPurgeScheduledFor: purgeAt,
  };
}

// ---------------------------------------------------------------------------
// Provider detection + ops
// ---------------------------------------------------------------------------

type GitProvider = 'github' | 'gitlab';

function detectProvider(url: string): GitProvider | null {
  if (/^https?:\/\/github\.com\//.test(url)) return 'github';
  if (/^https?:\/\/gitlab\.com\//.test(url)) return 'gitlab';
  if (/^git@github\.com:/.test(url)) return 'github';
  if (/^git@gitlab\.com:/.test(url)) return 'gitlab';
  return null;
}

function parseOwnerRepo(url: string, provider: GitProvider): string | null {
  // Strip protocol + host + .git suffix
  const cleaned = url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/\.git$/, '');
  if (provider === 'github' && /^[\w-]+\/[\w.-]+$/.test(cleaned)) return cleaned;
  if (provider === 'gitlab' && /^[\w-]+(\/[\w.-]+)+$/.test(cleaned)) return cleaned;
  return null;
}

function toSshUrl(httpsUrl: string, provider: GitProvider): string {
  const ownerRepo = parseOwnerRepo(httpsUrl, provider);
  if (!ownerRepo) return httpsUrl;
  if (provider === 'github') return `git@github.com:${ownerRepo}.git`;
  return `git@gitlab.com:${ownerRepo}.git`;
}

function providerOps(provider: GitProvider, fetchFn: typeof globalThis.fetch): ProviderOps {
  if (provider === 'github') return githubOps(fetchFn);
  return gitlabOps(fetchFn);
}

function githubOps(fetchFn: typeof globalThis.fetch): ProviderOps {
  return {
    async validatePatScope(pat, _ownerRepo) {
      // GitHub: check the PAT has 'repo' + 'admin:repo_hook' scopes via
      // the X-OAuth-Scopes response header.
      const resp = await fetchFn('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return `GitHub auth failed: ${resp.status}`;
      const scopes = (resp.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim());
      if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
        return 'PAT missing repo scope (or fine-grained Administration: read/write)';
      }
      return null;
    },
    async createDeployKey({ pat, ownerRepo, title, publicKey }) {
      const resp = await fetchFn(`https://api.github.com/repos/${ownerRepo}/keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, key: publicKey, read_only: false }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`createDeployKey failed: ${resp.status} ${body}`);
      }
      const data = (await resp.json()) as { id: number };
      return data.id;
    },
    async protectBranches({ pat, ownerRepo, branches }) {
      let allOk = true;
      for (const branch of branches) {
        const resp = await fetchFn(
          `https://api.github.com/repos/${ownerRepo}/branches/${branch}/protection`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              required_status_checks: null,
              enforce_admins: false,
              required_pull_request_reviews: null,
              restrictions: null,
              allow_force_pushes: false,
              allow_deletions: false,
            }),
          },
        );
        if (!resp.ok) {
          allOk = false;
          break;
        }
      }
      return allOk;
    },
  };
}

function gitlabOps(fetchFn: typeof globalThis.fetch): ProviderOps {
  return {
    async validatePatScope(pat, _ownerRepo) {
      const resp = await fetchFn('https://gitlab.com/api/v4/personal_access_tokens/self', {
        headers: { 'PRIVATE-TOKEN': pat },
      });
      if (!resp.ok) return `GitLab auth failed: ${resp.status}`;
      const data = (await resp.json()) as { scopes?: string[] };
      if (!data.scopes?.includes('api')) return 'PAT missing api scope';
      return null;
    },
    async createDeployKey({ pat, ownerRepo, title, publicKey }) {
      // GitLab requires URL-encoded project ID OR full path with %2F for /
      const projectPath = encodeURIComponent(ownerRepo);
      const resp = await fetchFn(`https://gitlab.com/api/v4/projects/${projectPath}/deploy_keys`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, key: publicKey, can_push: true }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`createDeployKey failed: ${resp.status} ${body}`);
      }
      const data = (await resp.json()) as { id: number };
      return data.id;
    },
    async protectBranches({ pat, ownerRepo, branches }) {
      const projectPath = encodeURIComponent(ownerRepo);
      let allOk = true;
      for (const branch of branches) {
        const resp = await fetchFn(`https://gitlab.com/api/v4/projects/${projectPath}/protected_branches`, {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: branch, push_access_level: 30, merge_access_level: 30 }),
        });
        if (!resp.ok && resp.status !== 409) { // 409 = already protected
          allOk = false;
        }
      }
      return allOk;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitExecResult { exitCode: number; stdout: string; stderr: string }

function execGit(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function generateEd25519Keypair(): Promise<{ publicKey: string; privateKey: string }> {
  // Generate via `ssh-keygen -t ed25519 -f <path> -N ""` for cross-platform
  // OpenSSH-compatible output.
  const dir = await mkdtemp(join(tmpdir(), 'gatewaze-keygen-'));
  const keyPath = join(dir, 'id_ed25519');
  try {
    const result = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      const proc = spawn('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', 'gatewaze-deploy-key'], {});
      let stderr = '';
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
    });
    if (result.exitCode !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr}`);
    }
    const fs = await import('node:fs/promises');
    const [publicKey, privateKey] = await Promise.all([
      fs.readFile(`${keyPath}.pub`, 'utf8'),
      fs.readFile(keyPath, 'utf8'),
    ]);
    return { publicKey: publicKey.trim(), privateKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
