/**
 * Pre-merge hook for the JSON-lock decision (i) — per spec-sites-wysiwyg-builder §5.5.
 *
 * Called before `applyTheme` performs the actual `gitServer.applyMerge`. For
 * each `content/pages/*.json` file modified by commits in the proposed merge
 * range, the hook:
 *
 *   1. Resolves the page slug from the file path (`content/pages/<slug>.json`).
 *   2. Looks up the corresponding `pages` row.
 *   3. If `wysiwyg_locked = true` AND the modifying commit lacks the
 *      `X-Gatewaze-Author: publish-worker-v…` trailer, REJECTS the merge with
 *      `apply.locked_content_modified` and surfaces `{ file, commitSha,
 *      expectedAuthor }` in the conflict response.
 *   4. If the page is not locked, or the trailer is present, passes through.
 *
 * This module is pure on top of an injected `inspectCommits` callback —
 * production wires that to the real git server's "list files changed in
 * commit range" + "read commit trailers" RPCs.
 */

export interface CommitInspection {
  /** SHA of the commit that touched this file. */
  commitSha: string;
  /** File path under the repo root. */
  filePath: string;
  /** Trailer value of `X-Gatewaze-Author` if present, else null. */
  workerAuthorTrailer: string | null;
}

export interface PageLockState {
  slug: string;
  wysiwygLocked: boolean;
}

export interface PreMergeHookDeps {
  /**
   * List the files changed in (fromBranch..toBranch) plus the trailer of the
   * commit that introduced each file change. Production: shells out to
   * `git log --name-only --pretty=format:%H` + `git interpret-trailers`.
   */
  inspectCommits: (args: {
    fromBranch: string;
    toBranch: string;
  }) => Promise<ReadonlyArray<CommitInspection>>;

  /**
   * Look up wysiwyg_locked for the pages whose slugs appear in the merge.
   * Bulk-fetched via `WHERE slug = ANY($1)`.
   */
  fetchPageLocks: (slugs: ReadonlyArray<string>) => Promise<ReadonlyArray<PageLockState>>;
}

export interface PreMergeRejection {
  code: 'apply.locked_content_modified';
  message: string;
  details: ReadonlyArray<{
    file: string;
    commitSha: string;
    slug: string;
    expectedAuthor: 'publish-worker';
  }>;
}

export type PreMergeResult = { ok: true } | { ok: false; rejection: PreMergeRejection };

const CONTENT_PAGE_RE = /^content\/pages\/(.+)\.json$/;
const WORKER_AUTHOR_PREFIX = 'publish-worker-v';

/**
 * Run the pre-merge check. Caller invokes this before `applyMerge`; on
 * `ok=false` the caller surfaces the rejection as a 409 to the apply-theme
 * endpoint without performing the merge.
 */
export async function preMergeCheck(
  deps: PreMergeHookDeps,
  args: { fromBranch: string; toBranch: string },
): Promise<PreMergeResult> {
  const inspections = await deps.inspectCommits(args);
  if (inspections.length === 0) return { ok: true };

  // Filter to content/pages/<slug>.json paths only.
  const pageInspections: Array<CommitInspection & { slug: string }> = [];
  for (const ins of inspections) {
    const m = CONTENT_PAGE_RE.exec(ins.filePath);
    if (!m) continue;
    pageInspections.push({ ...ins, slug: m[1] });
  }
  if (pageInspections.length === 0) return { ok: true };

  // Bulk-fetch lock state.
  const slugs = Array.from(new Set(pageInspections.map((p) => p.slug)));
  const locks = await deps.fetchPageLocks(slugs);
  const lockBySlug = new Map(locks.map((l) => [l.slug, l.wysiwygLocked]));

  const rejections: PreMergeRejection['details'][number][] = [];
  for (const ins of pageInspections) {
    if (!lockBySlug.get(ins.slug)) continue; // not locked — pass through
    if (ins.workerAuthorTrailer && ins.workerAuthorTrailer.startsWith(WORKER_AUTHOR_PREFIX)) {
      continue; // worker-authored — pass through
    }
    rejections.push({
      file: ins.filePath,
      commitSha: ins.commitSha,
      slug: ins.slug,
      expectedAuthor: 'publish-worker',
    });
  }

  if (rejections.length === 0) return { ok: true };

  return {
    ok: false,
    rejection: {
      code: 'apply.locked_content_modified',
      message: 'one or more JSON-locked pages were modified outside the canvas; canvas-locked pages can only be edited via the WYSIWYG editor',
      details: rejections,
    },
  };
}

export const PRE_MERGE_HOOK_INTERNALS = {
  CONTENT_PAGE_RE,
  WORKER_AUTHOR_PREFIX,
};
