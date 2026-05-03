/**
 * IGitDrivenPublisher contract — per spec-sites-theme-kinds §6.1.
 *
 * Sub-modules implementing this:
 *   - sites-publisher-stub-git    (test publisher with a local bare repo)
 *   - sites-publisher-vercel-git
 *   - sites-publisher-netlify-git
 *
 * Each publisher exports an instance of IGitDrivenPublisher and registers
 * via the platform's capability registry under capability id
 * `sites.gitDrivenPublisher`.
 */

export interface CommitFile {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
}

export interface CommitArgs {
  secrets: Record<string, string>;
  repoRef: { remote: string; branch: string };
  /** null for first commit on the branch. */
  baseCommitSha: string | null;
  files: ReadonlyArray<CommitFile>;
  message: string;
  author: { name: string; email: string };
}

export type CommitResult =
  | { ok: true; commitSha: string; deploymentUrl?: string }
  | {
      ok: false;
      kind: 'stale_base' | 'auth' | 'network' | 'rate_limited' | 'rejected';
      detail: string;
    };

export interface OpenPullRequestArgs {
  secrets: Record<string, string>;
  repoRef: { remote: string };
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
}

export type OpenPullRequestResult =
  | { ok: true; prUrl: string; prNumber: number }
  | { ok: false; kind: string; detail: string };

export interface VerifyWebhookArgs {
  secrets: Record<string, string>;
  headers: Record<string, string>;
  rawBody: Uint8Array;
}

export type BuildStatusEvent =
  | { kind: 'build_started';   commitSha: string; deploymentId: string; url?: string }
  | { kind: 'build_succeeded'; commitSha: string; deploymentId: string; url: string;  durationMs: number }
  | { kind: 'build_failed';    commitSha: string; deploymentId: string; logUrl?: string; reason: string }
  | { kind: 'build_cancelled'; commitSha: string; deploymentId: string };

export type VerifyWebhookResult =
  | { ok: true; event: BuildStatusEvent }
  | { ok: false; reason: string };

export type ValidateConfigResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface IGitDrivenPublisher {
  /** Stable identifier; matches `publishing_target.publisherId`. */
  readonly id: string;

  /** Validate the resolved secret bundle at site-create / publisher-config time. */
  validateConfig(secrets: Record<string, string>): Promise<ValidateConfigResult>;

  /**
   * Commit a set of files to the configured repo and branch. Returns the
   * new HEAD commit SHA. The publisher MUST refuse if `baseCommitSha`
   * doesn't match the branch's current HEAD (returns `stale_base`).
   */
  commit(args: CommitArgs): Promise<CommitResult>;

  /** Open a PR (only required if branch_strategy='pull_request'). */
  openPullRequest?(args: OpenPullRequestArgs): Promise<OpenPullRequestResult>;

  /** Verify a webhook payload from the deployment platform. */
  verifyWebhookSignature(args: VerifyWebhookArgs): Promise<VerifyWebhookResult>;

  /**
   * Optional: check whether `parent` is an ancestor of `child` in the
   * publisher's repo. Used by the webhook handler for the §6.5 fallback
   * matching path (commit-rebase / force-push scenarios).
   */
  isAncestor?(args: { secrets: Record<string, string>; parent: string; child: string }): Promise<boolean>;
}
