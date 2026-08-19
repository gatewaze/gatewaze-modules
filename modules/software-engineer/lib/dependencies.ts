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
 *   - Self-references and duplicates are ignored. A dependency issue confirmed GONE via a definitive
 *     404 fails OPEN (treated as met) — a typo'd issue number shouldn't park an issue forever
 *     silently, and the comment lists exactly which deps were considered so a typo is visible. Every
 *     other fetch failure (401/403 auth hiccup, 5xx, a network-level failure with no status at all)
 *     fails CLOSED (treated as unmet) — those errors look identical to "the dependency doesn't exist"
 *     but don't mean that, and letting them through created two premature intakes on staging (issue
 *     #59). A transient failure delays the run by one poll/webhook cycle instead of starting it early.
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

/** Classify a gh.getIssue() failure. Only a definitive 404 means "this issue genuinely doesn't
 *  exist" — everything else (401/403 auth hiccup, 5xx, a network-level failure with no status at
 *  all) must not be read as "dependency satisfied". */
function classifyFetchFailure(err: unknown): 'not_found' | 'unavailable' {
  const msg = err instanceof Error ? err.message : String(err);
  const m = / → (\d{3})$/.exec(msg);
  return m && m[1] === '404' ? 'not_found' : 'unavailable';
}

/** Log-safe rendering of a value that may carry remote-echoed content: control characters
 *  (incl. CR/LF) become spaces so one log call can never forge additional log lines. */
const logSafe = (v: unknown): string =>
  // eslint-disable-next-line no-control-regex
  String(v instanceof Error ? v.message : v).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

/** Which of `deps` are still open? A confirmed-404 dep counts as met (fail open); any other
 *  fetch failure (auth, 5xx, network) counts as unmet (fail closed) — see module doc comment. */
export async function unmetDependencies(gh, owner: string, name: string, deps: number[]): Promise<number[]> {
  const unmet: number[] = [];
  for (const num of deps) {
    try {
      const issue = await gh.getIssue(owner, name, num);
      if (issue && issue.state === 'open') unmet.push(num);
    } catch (err) {
      if (classifyFetchFailure(err) === 'not_found') {
        console.log(`se: dependencies — #${num} on ${logSafe(owner)}/${logSafe(name)} not found (404); fail-open, treating as met`);
      } else {
        console.warn(`se: dependencies — #${num} on ${logSafe(owner)}/${logSafe(name)} unfetchable (${logSafe(err)}); fail-closed, treating as unmet`);
        unmet.push(num);
      }
    }
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
