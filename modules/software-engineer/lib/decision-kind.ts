// @ts-nocheck
/**
 * Disambiguates the single `blocked` run status (and the other human-gated statuses) into a
 * `DecisionKind` — one place to see WHY a run is parked on a human, in plain language (issue #49).
 *
 * `blocked` alone conflates three very different situations: the adversarial skeptic exhausted its
 * retries (a spec problem, agent-discussable), a PR was closed unmerged (a code problem, discussable
 * via the `revise` phase), or the run is stuck on missing/invalid project config (`authorization` /
 * `kill_switch` from `blockRun` in lib/run-state.ts — not something chatting with the agent can fix).
 */

export type DecisionKind =
  | 'review_blocked'
  | 'pr_closed_partial'
  | 'config_blocked'
  | 'awaiting_spec'
  | 'awaiting_architecture'
  | 'ready_to_submit';

export interface RunRow {
  status: string;
  error?: string | null;
  retry_count?: number | null;
  [key: string]: unknown;
}

export interface RunPrRow {
  state?: string | null;
  [key: string]: unknown;
}

/**
 * Classify a run's decision kind, or `null` when the run isn't waiting on a human at all. The three
 * `blocked` sub-kinds are disambiguated in priority order: a closed-unmerged PR is the most actionable
 * signal (check it first even if the run's `error` also happens to mention review), then the skeptic's
 * own terminal error text (set verbatim in workers/review.ts), then fall back to `config_blocked` —
 * the catch-all for `authorization`/`kill_switch` blocks, which need a config fix, not a resume.
 */
export function classifyDecision(run: RunRow, prs: RunPrRow[]): DecisionKind | null {
  if (run.status === 'awaiting_spec') return 'awaiting_spec';
  if (run.status === 'awaiting_architecture' || run.status === 'architecture_in_review') return 'awaiting_architecture';
  if (run.status === 'ready_to_submit') return 'ready_to_submit';
  if (run.status !== 'blocked') return null;
  if ((prs ?? []).some((p) => p.state === 'closed_unmerged')) return 'pr_closed_partial';
  if (/adversarial review blocked/.test(run.error ?? '')) return 'review_blocked';
  return 'config_blocked';
}

/** Plain-language "Decisions needed" panel text per kind (GET /overview/decisions). */
export function decisionTextFor(kind: DecisionKind, run: RunRow): string {
  switch (kind) {
    case 'review_blocked':
      return `Skeptic rejected the spec after ${run.retry_count ?? 0} revisions — decide: enrich the issue, override, or drop`;
    case 'pr_closed_partial':
      return 'A pull request was closed without merging — needs a human decision';
    case 'config_blocked':
      return run.error || 'Blocked — configuration issue';
    case 'awaiting_spec':
      return 'Spec awaiting approval';
    case 'awaiting_architecture':
      return 'Architecture proposal awaiting review';
    case 'ready_to_submit':
      return 'Pull request ready — awaiting submission';
    default:
      return '';
  }
}

/**
 * The block-reason line folded into the admin-note message a resume inserts before enqueuing (issue
 * #49 §5) — this is what the resumed agent actually reads via drainPendingAdminMessages, so it must
 * carry the SAME classification the human saw on the Decisions panel, not just the raw run.error.
 */
export function blockSummaryFor(kind: DecisionKind | null, run: RunRow, gateDetail?: { objections?: string[] } | null): string {
  switch (kind) {
    case 'review_blocked': {
      const objections = gateDetail?.objections ?? [];
      return objections.length
        ? `Skeptic objections to resolve: ${objections.join('; ')}`
        : 'The skeptic blocked the spec after review (retries exhausted).';
    }
    case 'pr_closed_partial':
      return 'A pull request was closed without merging — address the reviewer\'s reason and push a fix.';
    case 'config_blocked':
      return `Blocked: ${run.error ?? 'unknown reason'}`;
    default:
      // kind === null covers the plain `failed` resume path, which has no DecisionKind of its own.
      return `Original failure: ${run.error ?? 'unknown'}`;
  }
}
