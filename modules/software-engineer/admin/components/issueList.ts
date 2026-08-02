/**
 * Pure helpers for the Issues tab list (SoftwareEngineerTab → IssuesView).
 *
 * The issue list is aggregated live from GitHub (source of truth), while just-created issues are held
 * as optimistic rows because GitHub's list endpoint is eventually consistent — the immediate refetch
 * usually omits the issue we just created. These helpers merge the two views and reconcile them,
 * keyed by project + issue number (the optimistic row has no repo slug yet, so repo is not part of
 * the key).
 */

export type IssueLike = { project?: { id?: string } | null; number?: number };

/** Stable identity for an issue row across optimistic and GitHub-backed views. */
export const issueKey = (i: IssueLike | null | undefined): string => `${i?.project?.id}#${i?.number}`;

/**
 * Optimistic rows the GitHub-backed list has NOT yet surfaced — used both to prune landed rows from
 * state and to compute what to render above the real list.
 */
export function pendingOptimistic<T extends IssueLike>(optimistic: T[], issues: IssueLike[]): T[] {
  const present = new Set((issues ?? []).map(issueKey));
  return (optimistic ?? []).filter((x) => !present.has(issueKey(x)));
}

/** Render order: pending optimistic rows first, then the GitHub-backed list. */
export function mergeIssues<T extends IssueLike>(optimistic: T[], issues: T[]): T[] {
  return [...pendingOptimistic(optimistic, issues), ...(issues ?? [])];
}
