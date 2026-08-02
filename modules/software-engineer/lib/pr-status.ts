// @ts-nocheck
/**
 * PR derived-status classification for the Overview PR board. Pure functions — no I/O — so the
 * decision table is unit-testable. Takes the raw GitHub signals (pull detail, latest reviews,
 * check-run rollup) plus the optional linked SE run, and answers the question the dashboard
 * exists to answer: "where is this PR, and WHO acts next?" — without opening the PR.
 *
 * actor semantics:
 *   'you'       — YOU (the board's PAT user) must do something you're able to: address changes on
 *                 your own PR, fix CI, resolve conflicts, or merge (when you have write access)
 *   'reviewers' — waiting on SOMEONE ELSE: a required review, or a maintainer to merge, on a PR you
 *                 authored (you can't review/merge your own). These are NOT "yours" to action alone.
 *   'agent'     — an active SE run owns the next step (revising, fixing CI)
 *   'auto'      — the platform will progress it unaided (auto-merge, branch self-heal, CI running)
 *   'none'      — terminal (merged/closed) or nothing to do
 */

export type PrDerivedStatus =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'conflicts'
  | 'ci_failing'
  | 'ci_running'
  | 'changes_requested'
  | 'agent_revising'
  | 'auto_merge_pending'
  | 'awaiting_merge'
  | 'awaiting_review'
  | 'behind'
  | 'blocked'
  | 'unknown';

export interface ChecksSummary {
  total: number;
  failing: number;
  pending: number;
}

/** Roll up a GitHub check-runs list (REST /commits/:ref/check-runs). */
export function summarizeChecks(checkRuns: Array<Record<string, unknown>> | null | undefined): ChecksSummary {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  let failing = 0;
  let pending = 0;
  for (const c of runs) {
    if (c?.status !== 'completed') { pending += 1; continue; }
    // Conclusions that mean "red": failure, timed_out, cancelled (a cancelled required check still
    // blocks), action_required. neutral/skipped/success are not failures.
    if (['failure', 'timed_out', 'cancelled', 'action_required'].includes(String(c?.conclusion))) failing += 1;
  }
  return { total: runs.length, failing, pending };
}

export interface ReviewsSummary {
  approved: boolean;
  changesRequested: boolean;
  reviewers: number;
}

/** Latest review per reviewer wins (a re-approval clears an earlier CHANGES_REQUESTED). */
export function summarizeReviews(reviews: Array<Record<string, unknown>> | null | undefined): ReviewsSummary {
  const latest = new Map<string, string>();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const who = String(r?.user?.login ?? '');
    const state = String(r?.state ?? '');
    // COMMENTED/PENDING/DISMISSED don't change a reviewer's standing verdict.
    if (!who || !['APPROVED', 'CHANGES_REQUESTED'].includes(state)) continue;
    latest.set(who, state);
  }
  const states = [...latest.values()];
  return {
    approved: states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED'),
    changesRequested: states.includes('CHANGES_REQUESTED'),
    reviewers: latest.size,
  };
}

export interface ClassifyInput {
  state: 'open' | 'closed';        // GitHub PR state
  merged: boolean;
  draft: boolean;
  /** GitHub mergeable_state: clean | behind | blocked | dirty | unstable | unknown | has_hooks */
  mergeableState: string;
  checks: ChecksSummary;
  reviews: ReviewsSummary;
  /** Linked SE run, when this PR was opened by a pipeline run. */
  run?: {
    status: string;                // se_runs.status
    blastRadius: string;           // safe | needs_human | unknown
    autonomyMode: string;          // pr_only | auto_merge_safe
  } | null;
  /** The board's PAT user authored this PR (default false). GitHub forbids reviewing your own PR,
   *  so an author's "needs review" is waiting on OTHERS, never on you. The Overview board is an
   *  author:@me search, so it passes true. */
  viewerIsAuthor?: boolean;
  /** The board's PAT user has write/merge access on the repo (default true → preserves prior
   *  behaviour). When false, a green/approved PR is "waiting on a maintainer to merge", not you. */
  viewerCanMerge?: boolean;
  /** The board's PAT user is a REQUESTED reviewer on this PR (default false). This is what makes a
   *  "needs review" PR actually yours to action; otherwise it's awaiting whoever IS requested. */
  viewerIsRequestedReviewer?: boolean;
}

export interface DerivedPrStatus {
  status: PrDerivedStatus;
  actor: 'you' | 'reviewers' | 'agent' | 'auto' | 'none';
  label: string;                   // short chip text
  detail: string;                  // one-line explanation of what's happening / needed
}

const ACTIVE_RUN_STATUSES = new Set(['running', 'watching', 'changes_requested', 'pr_open']);

export function classifyPr(i: ClassifyInput): DerivedPrStatus {
  const runActive = !!i.run && ACTIVE_RUN_STATUSES.has(i.run.status);
  const autoMerge = !!i.run && i.run.autonomyMode === 'auto_merge_safe' && i.run.blastRadius === 'safe';

  if (i.merged) return { status: 'merged', actor: 'none', label: 'Merged', detail: 'Landed.' };
  if (i.state === 'closed') return { status: 'closed', actor: 'none', label: 'Closed', detail: 'Closed without merging.' };
  if (i.draft) {
    return { status: 'draft', actor: runActive ? 'agent' : 'you', label: 'Draft', detail: 'Marked as draft — not ready for review yet.' };
  }
  if (i.mergeableState === 'dirty') {
    return {
      status: 'conflicts',
      actor: runActive ? 'agent' : 'you',
      label: 'Conflicts',
      detail: runActive ? 'Merge conflicts with base — the agent will rebase on its next pass.' : 'Merge conflicts with base — needs a manual rebase.',
    };
  }
  if (i.checks.failing > 0) {
    return {
      status: 'ci_failing',
      actor: runActive ? 'agent' : 'you',
      label: 'CI failing',
      detail: `${i.checks.failing} of ${i.checks.total} checks failing${runActive ? ' — the agent watches CI and revises' : ' — needs fixes'}.`,
    };
  }
  if (i.checks.pending > 0) {
    return { status: 'ci_running', actor: 'auto', label: 'CI running', detail: `${i.checks.pending} check(s) still running — no action needed yet.` };
  }
  if (i.reviews.changesRequested) {
    if (runActive) {
      return { status: 'agent_revising', actor: 'agent', label: 'Agent revising', detail: 'A reviewer requested changes — the agent is addressing the feedback.' };
    }
    // The author addresses changes. If that's not you (someone else's PR on the board), it's not
    // yours to action. `viewerIsAuthor` defaults undefined → treated as "yours" to preserve the
    // single-author (author:@me) behaviour the tests pin.
    return i.viewerIsAuthor === false
      ? { status: 'changes_requested', actor: 'reviewers', label: 'Changes requested', detail: 'A reviewer requested changes — waiting on the author.' }
      : { status: 'changes_requested', actor: 'you', label: 'Changes requested', detail: 'A reviewer requested changes — awaiting the author.' };
  }
  if (i.mergeableState === 'clean') {
    if (autoMerge && runActive) {
      return { status: 'auto_merge_pending', actor: 'auto', label: 'Auto-merge', detail: 'Green and rated safe — auto-merge will land it on the next tick.' };
    }
    // Green + mergeable. Whether it's YOURS to merge depends on write access — a PR you authored on a
    // repo you can't push to is waiting on a maintainer, not on you.
    const canMerge = i.viewerCanMerge !== false;
    return {
      status: 'awaiting_merge',
      actor: canMerge ? 'you' : 'reviewers',
      label: canMerge ? 'Ready to merge' : 'Ready — needs a maintainer',
      detail: canMerge
        ? (i.reviews.approved ? 'Approved and green — waiting on a human to merge.' : 'Green and mergeable — waiting on a human to merge.')
        : (i.reviews.approved ? 'Approved and green — waiting on a maintainer with merge access.' : 'Green and mergeable — waiting on a maintainer with merge access.'),
    };
  }
  if (i.mergeableState === 'behind') {
    if (autoMerge && runActive) {
      return { status: 'behind', actor: 'auto', label: 'Updating branch', detail: 'Behind base — the merge worker updates the branch and lands it once checks re-run green.' };
    }
    return { status: 'behind', actor: 'you', label: 'Behind base', detail: 'Out of date with the base branch — needs “Update branch”, then checks re-run.' };
  }
  if (i.mergeableState === 'blocked') {
    if (i.reviews.approved) {
      // Approved + green but branch protection still blocks (code-scanning, merge queue, required
      // reviewers rule). If you can't merge here, it's on a maintainer; otherwise it's on you.
      const canMerge = i.viewerCanMerge !== false;
      return { status: 'blocked', actor: canMerge ? 'you' : 'reviewers', label: 'Blocked',
        detail: canMerge
          ? 'Approved and checks green, but branch protection still blocks the merge (e.g. a code-scanning alert or merge queue).'
          : 'Approved and green, but branch protection blocks the merge — waiting on a maintainer / required reviewer.' };
    }
    // Needs a human review. It's YOURS to action only if you're a requested reviewer — you can't
    // review your own PR, and a teammate's PR you're not on isn't yours either. Otherwise it's
    // awaiting whoever IS requested.
    return i.viewerIsRequestedReviewer
      ? { status: 'awaiting_review', actor: 'you', label: 'Your review requested', detail: 'Checks green — your review is requested.' }
      : { status: 'awaiting_review', actor: 'reviewers', label: 'Awaiting review', detail: 'Checks green — waiting on the required reviewer(s).' };
  }
  if (i.mergeableState === 'unstable') {
    const canMerge = i.viewerCanMerge !== false;
    return { status: 'awaiting_merge', actor: canMerge ? 'you' : 'reviewers', label: 'Mergeable (unstable)',
      detail: canMerge
        ? 'Mergeable, but a non-required check is failing — merge is allowed.'
        : 'Mergeable (a non-required check is failing) — waiting on a maintainer to merge.' };
  }
  return { status: 'unknown', actor: 'none', label: 'Computing…', detail: 'GitHub is still computing this PR’s merge state.' };
}
