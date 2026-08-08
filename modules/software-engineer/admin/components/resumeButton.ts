import { classifyDecision, decisionTextFor } from '../../lib/decision-kind.js';

/**
 * The Resume button's disabled-with-reason logic (issue #36), extracted so it is unit-testable
 * without mounting SoftwareEngineerTab.tsx (this workspace's vitest env is 'node', no jsdom).
 * A `null` result means the button is enabled; a non-null string is both the disabled reason and
 * the visible explanatory text next to the button — the button must never be a silent no-op.
 */
export function resumeBlockedReason(run: { archived_at: string | null; kind: string }): string | null {
  if (run.archived_at) return 'Unarchive to resume';
  if (run.kind === 'interactive') return "Interactive sessions can't be resumed this way";
  return null;
}

/**
 * Non-disabling hint shown next to Resume for a `blocked` run (issue #49 §5) — unlike
 * `resumeBlockedReason`, this never disables the button: `/runs/:id/resume` accepts every
 * DecisionKind including `config_blocked` (it just retries the current phase), so the admin should
 * still be able to click Resume. The hint just tells them WHAT resuming will do before they click,
 * since it means something different per kind (redraft the spec vs. retry `revise` vs. retry the same
 * config-blocked phase).
 */
export function resumeHintFor(
  run: { status: string; error?: string | null; retry_count?: number | null },
  prs: Array<{ state?: string | null }> = [],
): string | null {
  if (run.status !== 'blocked') return null;
  const kind = classifyDecision(run, prs);
  return kind ? decisionTextFor(kind, run) : null;
}

/** Kind-aware confirm-dialog text for the Resume button (issue #49 §5). */
export function resumeConfirmText(
  run: { status: string; error?: string | null; retry_count?: number | null },
  prs: Array<{ state?: string | null }> = [],
): string {
  if (run.status !== 'blocked') return 'Resume this run? It will retry the phase that failed.';
  switch (classifyDecision(run, prs)) {
    case 'review_blocked':
      return "Resume this run? The agent will redraft the spec addressing the skeptic's objections.";
    case 'pr_closed_partial':
      return 'Resume this run? The agent will revise the code to address why the pull request was closed.';
    case 'config_blocked':
      return 'Resume this run? It will retry the same phase — if the underlying configuration issue is not fixed, it will likely block again.';
    default:
      return 'Resume this run? It will retry the phase that failed.';
  }
}
