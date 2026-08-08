// @ts-nocheck
/**
 * Issue dependency sequencing (operator directive 2026-08-08): an issue may declare that it depends
 * on other issues in the SAME issues repo, and the module defers it — visibly — until every
 * dependency is done, instead of running it early and failing/blocking on missing groundwork.
 *
 * Declaration, anywhere in the issue body (case-insensitive):
 *     Depends on #12
 *     Depends-on: #12, #14
 *     depends on #12 and #13
 *
 * Semantics:
 *   - A dependency is MET when its issue is CLOSED (the pipeline closes issues when their PRs
 *     merge, so closed == landed; manually-closed counts too — a human saying "done/won't do").
 *   - Both intake paths (webhook + poll) consult this BEFORE creating a run. Unmet → no run; the
 *     issue gets the `agent:waiting` marker label and ONE explanatory comment (the label doubles as
 *     the have-we-commented-already latch). Every subsequent poll re-checks; when the last dep
 *     closes, the marker is removed and the run dispatches automatically. Nothing ends up blocked
 *     or failed merely because it was labelled before its prerequisites landed.
 *   - Self-references and duplicates are ignored. Unknown issue numbers fail OPEN (treated as met,
 *     with the reasoning that a typo shouldn't park an issue forever silently — the comment lists
 *     exactly which deps were considered so a typo is visible).
 */

export const WAITING_LABEL = 'agent:waiting';
// Cap on declared deps: bounds the per-issue GitHub API fan-out from an untrusted body (security
// review 2026-08-08 — ~9k refs fit in a GitHub body; 20 is far beyond any legitimate chain).
export const MAX_DEPS = 20;

/** Extract dependency issue numbers from an issue body. Same-repo `#N` references only. */
export function parseDependencies(body: string, selfNumber?: number): number[] {
  const out = new Set<number>();
  if (!body) return [];
  const re = /depends[\s-]*on:?\s*((?:(?:#\d+)[,\s]*(?:and\s+)?)+)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const n of m[1].match(/#(\d+)/g) ?? []) {
      const num = Number(n.slice(1));
      if (Number.isFinite(num) && num > 0 && num !== selfNumber) out.add(num);
    }
  }
  return [...out].sort((a, b) => a - b).slice(0, MAX_DEPS);
}

/** Which of `deps` are still open? Unknown/unfetchable issues count as met (fail open, visibly). */
export async function unmetDependencies(gh, owner: string, name: string, deps: number[]): Promise<number[]> {
  const unmet: number[] = [];
  for (const num of deps) {
    try {
      const issue = await gh.getIssue(owner, name, num);
      if (issue && issue.state === 'open') unmet.push(num);
    } catch { /* unfetchable → treated as met; the marker comment names every dep considered */ }
  }
  return unmet;
}

/**
 * Mark an issue as waiting on `unmet` deps: add the marker label, and post the explanatory comment
 * only when the label wasn't already present (so re-polls don't spam). Best-effort throughout.
 */
export async function ensureWaitingMarker(gh, owner: string, name: string, number: number, currentLabels: string[], unmet: number[], allDeps: number[]) {
  if (currentLabels.includes(WAITING_LABEL)) return;
  try { await gh.addLabels(owner, name, number, [WAITING_LABEL]); } catch { /* best-effort */ }
  try {
    await gh.postComment(owner, name, number,
      `Waiting on ${unmet.map((n) => `#${n}`).join(', ')} before starting (declared dependencies: ${allDeps.map((n) => `#${n}`).join(', ')}). ` +
      `This issue will start automatically once they close — no need to re-label.`);
  } catch { /* best-effort */ }
}

/** Clear the waiting marker once deps are met (no comment — the run's own claim comment follows). */
export async function clearWaitingMarker(gh, owner: string, name: string, number: number, currentLabels: string[]) {
  if (!currentLabels.includes(WAITING_LABEL)) return;
  try { await gh.removeLabel(owner, name, number, WAITING_LABEL); } catch { /* best-effort */ }
}
