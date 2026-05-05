/**
 * In-memory stub IGitDrivenPublisher — used by integration tests + local
 * dev where there's no real Git host to push to.
 *
 * Per spec-sites-theme-kinds §15.3, this is the "stub publisher" that
 * lets us exercise the full publish flow (commit → webhook → finalize)
 * without standing up a real GitHub / GitLab / Vercel project.
 *
 * Behaviour:
 *   - commit() stores file contents in an in-memory tree keyed by branch,
 *     advances HEAD with a deterministic SHA derived from the file payload
 *     so tests can assert exact values.
 *   - The first commit on a branch accepts baseCommitSha=null. Subsequent
 *     commits must match the current HEAD or get `stale_base` (mirrors the
 *     real optimistic-locking contract in §6.3).
 *   - verifyWebhookSignature uses HMAC-SHA256 with key 'stub-secret' over
 *     the raw body. The matching event JSON shape is documented below.
 *
 * Test helpers (NOT part of IGitDrivenPublisher):
 *   - getBranches() / getCommits(branch) / getFiles(branch)
 *   - emitWebhook(commitSha, status) — produces a signed body the test
 *     can post to the webhook receiver.
 *   - reset() — clears all in-memory state between tests.
 */

import { createHash, createHmac } from 'node:crypto';
import type {
  IGitDrivenPublisher,
  CommitArgs,
  CommitResult,
  ValidateConfigResult,
  VerifyWebhookArgs,
  VerifyWebhookResult,
  BuildStatusEvent,
} from './types.js';

interface CommitRecord {
  sha: string;
  parent: string | null;
  files: Map<string, string>;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}

const HMAC_KEY = 'stub-secret';

export interface StubGitDrivenPublisher extends IGitDrivenPublisher {
  /** Test-only: returns the list of branch names that have at least one commit. */
  getBranches(): string[];
  /** Test-only: returns commits on a branch in chronological order. */
  getCommits(branch: string): CommitRecord[];
  /** Test-only: returns the file tree at the branch's current HEAD. */
  getFiles(branch: string): Map<string, string>;
  /**
   * Test-only: produces a (rawBody, signature) pair the test can feed to
   * the webhook receiver. The receiver should, on calling
   * verifyWebhookSignature, return { ok: true, event }.
   */
  emitWebhook(event: BuildStatusEvent): { rawBody: Uint8Array; signature: string };
  /** Test-only: clears all in-memory state. */
  reset(): void;
}

export function createStubGitDrivenPublisher(): StubGitDrivenPublisher {
  // Branch → ordered list of commits (most recent last).
  const branches = new Map<string, CommitRecord[]>();

  function head(branch: string): string | null {
    const list = branches.get(branch);
    if (!list || list.length === 0) return null;
    return list[list.length - 1]!.sha;
  }

  function deriveSha(parent: string | null, files: ReadonlyArray<{ path: string; content: string }>): string {
    const hash = createHash('sha1');
    hash.update(parent ?? '');
    for (const f of files) {
      hash.update('\0');
      hash.update(f.path);
      hash.update('\0');
      hash.update(f.content);
    }
    return hash.digest('hex');
  }

  return {
    id: 'stub-git',

    async validateConfig(_secrets: Record<string, string>): Promise<ValidateConfigResult> {
      return { ok: true };
    },

    async commit(args: CommitArgs): Promise<CommitResult> {
      const branch = args.repoRef.branch;
      const currentHead = head(branch);

      // Optimistic locking — mirror the real publisher contract.
      if (args.baseCommitSha !== currentHead) {
        return {
          ok: false,
          kind: 'stale_base',
          detail: `expected base ${currentHead ?? '<empty>'}, got ${args.baseCommitSha ?? '<null>'}`,
        };
      }

      const files = new Map<string, string>();
      // Carry forward existing files (a real Git commit is incremental).
      const existing = branches.get(branch);
      if (existing && existing.length > 0) {
        for (const [path, content] of existing[existing.length - 1]!.files) {
          files.set(path, content);
        }
      }
      // Apply this commit's files.
      for (const f of args.files) {
        files.set(f.path, f.content);
      }

      const sha = deriveSha(currentHead, args.files);
      const record: CommitRecord = {
        sha,
        parent: currentHead,
        files,
        message: args.message,
        author: args.author,
        timestamp: Date.now(),
      };
      const list = branches.get(branch) ?? [];
      list.push(record);
      branches.set(branch, list);

      return { ok: true, commitSha: sha };
    },

    async verifyWebhookSignature(args: VerifyWebhookArgs): Promise<VerifyWebhookResult> {
      const provided = args.headers['x-stub-signature'] ?? args.headers['X-Stub-Signature'];
      if (!provided) return { ok: false, reason: 'missing_signature' };

      const expected = createHmac('sha256', HMAC_KEY)
        .update(Buffer.from(args.rawBody))
        .digest('hex');
      if (provided !== expected) return { ok: false, reason: 'bad_signature' };

      try {
        const parsed = JSON.parse(Buffer.from(args.rawBody).toString('utf-8')) as BuildStatusEvent;
        if (typeof parsed?.kind !== 'string') {
          return { ok: false, reason: 'unparseable_event' };
        }
        return { ok: true, event: parsed };
      } catch {
        return { ok: false, reason: 'bad_json' };
      }
    },

    async isAncestor(args: { parent: string; child: string }): Promise<boolean> {
      // Walk every branch's commit chain and look for parent in the
      // ancestors of any commit whose sha is `child`.
      for (const list of branches.values()) {
        const childIdx = list.findIndex((c) => c.sha === args.child);
        if (childIdx < 0) continue;
        for (let i = childIdx; i >= 0; i--) {
          if (list[i]!.sha === args.parent) return true;
        }
      }
      return false;
    },

    // ----- test helpers (not part of IGitDrivenPublisher) -----

    getBranches(): string[] {
      return Array.from(branches.keys()).filter((b) => (branches.get(b)?.length ?? 0) > 0);
    },

    getCommits(branch: string): CommitRecord[] {
      return branches.get(branch) ?? [];
    },

    getFiles(branch: string): Map<string, string> {
      const list = branches.get(branch);
      if (!list || list.length === 0) return new Map();
      return new Map(list[list.length - 1]!.files);
    },

    emitWebhook(event: BuildStatusEvent): { rawBody: Uint8Array; signature: string } {
      const rawBody = Buffer.from(JSON.stringify(event), 'utf-8');
      const signature = createHmac('sha256', HMAC_KEY).update(rawBody).digest('hex');
      return { rawBody: new Uint8Array(rawBody), signature };
    },

    reset(): void {
      branches.clear();
    },
  };
}
