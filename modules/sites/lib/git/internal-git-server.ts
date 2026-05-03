/**
 * Internal git server — interface + stub implementation.
 *
 * Per spec-content-modules-git-architecture §6.3:
 *   - Bare repos on a PVC at /var/gatewaze/git/<host_kind>/<slug>.git
 *   - HTTPS smart-protocol endpoint at /git/:hostKind/:slug.git/...
 *   - JWT auth for admin clones; short-lived signed URLs for in-cluster builds
 *   - Worker pool isolation (default 4 workers)
 *   - Per-repo size cap (default 500 MB)
 *   - 30-day grace period before purge
 *
 * Full implementation deferred to its own session — needs:
 *   1. HTTP smart-protocol handler (git-upload-pack / git-receive-pack)
 *   2. Worker-pool subprocess manager (shell-out to `git`)
 *   3. Signed-URL minting endpoint (HMAC + IP-CIDR binding)
 *   4. Branch protection enforcement (refuse pushes to refs outside main/publish)
 *   5. Size-cap enforcement at receive-pack time
 *
 * This file declares the public interface so the rest of the system
 * (publish flow, boilerplate cloner, drift watcher) can target it.
 */

export interface InternalRepoRef {
  hostKind: 'site' | 'list';
  hostId: string;
  slug: string;
  barePath: string; // /var/gatewaze/git/<host_kind>/<slug>.git
  defaultBranch: string;
}

export interface CreateRepoArgs {
  hostKind: 'site' | 'list';
  hostId: string;
  slug: string;
  /** Optional: clone from a boilerplate at this URL+tag. */
  boilerplate?: { url: string; tag: string };
  /** Initial commit metadata. */
  initialCommitter?: { name: string; email: string };
}

export interface PublishCommitArgs {
  repo: InternalRepoRef;
  branch: 'publish';
  /** Files to write to the working tree (relative paths → contents). */
  files: Map<string, Buffer | string>;
  /** Files to remove from the working tree. */
  removals?: string[];
  message: string;
  /** Optional tag to apply to the new commit. */
  tag?: string;
  author: { name: string; email: string };
}

export interface CommitResult {
  sha: string;
  tag?: string;
  diffBytes: number;
  filesChanged: number;
}

export interface ApplyMergeArgs {
  repo: InternalRepoRef;
  fromBranch: string; // 'main'
  toBranch: string;   // 'publish'
  message: string;
  author: { name: string; email: string };
  /** When true, fail on any conflict (no auto-merge of overlapping content/). */
  failOnConflict: boolean;
}

export interface MergeResult {
  appliedCommit: string | null;
  filesChanged: number;
  conflicts: Array<{ path: string; reason: string }>;
}

export interface SignedUrlArgs {
  repo: InternalRepoRef;
  op: 'read';
  ttlSeconds: number;
  ipCidr?: string;
}

export interface InternalGitServer {
  /**
   * Create a bare repo at the conventional path. Optionally clone from a
   * boilerplate (e.g., `gatewaze-template-site@v1.0.0`), customize
   * package.json with the site name, and push the initial commit.
   * Idempotent — returns existing ref if one is already registered.
   */
  createRepo(args: CreateRepoArgs): Promise<InternalRepoRef>;

  /**
   * Lookup a repo by host. Returns null if not found.
   */
  lookupRepo(hostKind: 'site' | 'list', hostId: string): Promise<InternalRepoRef | null>;

  /**
   * Soft-delete the repo (sets `deleted_at`; bare directory is retained for
   * 30 days). Restore via restoreRepo() within that window.
   */
  softDeleteRepo(repo: InternalRepoRef): Promise<void>;

  /** Restore a soft-deleted repo within the 30-day grace period. */
  restoreRepo(repo: InternalRepoRef): Promise<void>;

  /** Hard-delete after grace period. Operator-triggered or background sweeper. */
  hardDeleteRepo(repo: InternalRepoRef): Promise<void>;

  /**
   * Atomically write content + commit + (optionally) tag + push.
   * Holds the per-repo Postgres advisory lock (per spec §6.2) to prevent
   * concurrent writes.
   */
  publishCommit(args: PublishCommitArgs): Promise<CommitResult>;

  /**
   * Merge `fromBranch` into `toBranch` and push. Conflict reporting
   * is structured for the apply UX (per spec §6.2).
   */
  applyMerge(args: ApplyMergeArgs): Promise<MergeResult>;

  /**
   * Fetch the HEAD SHA of a branch (or null if branch missing).
   */
  getHeadSha(repo: InternalRepoRef, branch: string): Promise<string | null>;

  /**
   * Mint a short-lived signed URL for in-cluster build pipelines.
   * Per spec §6.3: HMAC-signed, scoped to a single op + IP CIDR.
   */
  mintSignedUrl(args: SignedUrlArgs): Promise<string>;

  /**
   * Compute the current size of the bare repo (bytes). Used for cap
   * enforcement and the size-warning alert.
   */
  getRepoSize(repo: InternalRepoRef): Promise<number>;
}

// ---------------------------------------------------------------------------
// Stub implementation — throws "not yet implemented" with hints.
// Replace with a real implementation in a follow-up session.
// ---------------------------------------------------------------------------

export class StubInternalGitServer implements InternalGitServer {
  async createRepo(args: CreateRepoArgs): Promise<InternalRepoRef> {
    throw new Error(
      `[internal-git-server stub] createRepo not implemented. Args: ${JSON.stringify(args)}. ` +
      `See spec-content-modules-git-architecture §6.3 for the implementation contract.`,
    );
  }
  async lookupRepo(): Promise<InternalRepoRef | null> {
    return null;
  }
  async softDeleteRepo(): Promise<void> {
    throw new Error('[internal-git-server stub] softDeleteRepo not implemented');
  }
  async restoreRepo(): Promise<void> {
    throw new Error('[internal-git-server stub] restoreRepo not implemented');
  }
  async hardDeleteRepo(): Promise<void> {
    throw new Error('[internal-git-server stub] hardDeleteRepo not implemented');
  }
  async publishCommit(): Promise<CommitResult> {
    throw new Error('[internal-git-server stub] publishCommit not implemented');
  }
  async applyMerge(): Promise<MergeResult> {
    throw new Error('[internal-git-server stub] applyMerge not implemented');
  }
  async getHeadSha(): Promise<string | null> {
    return null;
  }
  async mintSignedUrl(): Promise<string> {
    throw new Error('[internal-git-server stub] mintSignedUrl not implemented');
  }
  async getRepoSize(): Promise<number> {
    return 0;
  }
}
