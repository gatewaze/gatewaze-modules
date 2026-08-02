import { describe, it, expect } from 'vitest';
import { classifyPr, summarizeChecks, summarizeReviews } from '../../lib/pr-status';

const CHECKS_GREEN = { total: 3, failing: 0, pending: 0 };
const NO_REVIEWS = { approved: false, changesRequested: false, reviewers: 0 };
const APPROVED = { approved: true, changesRequested: false, reviewers: 1 };

function base(overrides: Record<string, unknown> = {}) {
  return {
    state: 'open' as const, merged: false, draft: false, mergeableState: 'clean',
    checks: CHECKS_GREEN, reviews: NO_REVIEWS, run: null,
    ...overrides,
  };
}
const safeRun = { status: 'watching', blastRadius: 'safe', autonomyMode: 'auto_merge_safe' };

describe('summarizeChecks', () => {
  it('counts failing (incl. timed_out/cancelled/action_required) and pending', () => {
    const s = summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'completed', conclusion: 'timed_out' },
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'action_required' },
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'neutral' },
      { status: 'in_progress', conclusion: null },
      { status: 'queued', conclusion: null },
    ]);
    expect(s).toEqual({ total: 9, failing: 4, pending: 2 });
  });
  it('handles empty/null', () => {
    expect(summarizeChecks(null)).toEqual({ total: 0, failing: 0, pending: 0 });
  });
});

describe('summarizeReviews', () => {
  it('latest review per reviewer wins — re-approval clears changes_requested', () => {
    const s = summarizeReviews([
      { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'a' }, state: 'APPROVED' },
    ]);
    expect(s).toEqual({ approved: true, changesRequested: false, reviewers: 1 });
  });
  it('an outstanding CHANGES_REQUESTED from anyone blocks approved', () => {
    const s = summarizeReviews([
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'b' }, state: 'CHANGES_REQUESTED' },
    ]);
    expect(s.approved).toBe(false);
    expect(s.changesRequested).toBe(true);
  });
  it('COMMENTED does not change standing', () => {
    const s = summarizeReviews([
      { user: { login: 'a' }, state: 'APPROVED' },
      { user: { login: 'a' }, state: 'COMMENTED' },
    ]);
    expect(s.approved).toBe(true);
  });
});

describe('classifyPr — terminal + draft', () => {
  it('merged', () => expect(classifyPr(base({ merged: true })).status).toBe('merged'));
  it('closed unmerged', () => expect(classifyPr(base({ state: 'closed' })).status).toBe('closed'));
  it('draft (external → you)', () => {
    const d = classifyPr(base({ draft: true }));
    expect(d.status).toBe('draft');
    expect(d.actor).toBe('you');
  });
  it('draft with active run → agent', () => {
    expect(classifyPr(base({ draft: true, run: safeRun })).actor).toBe('agent');
  });
});

describe('classifyPr — problem states outrank merge state', () => {
  it('conflicts (dirty)', () => {
    const d = classifyPr(base({ mergeableState: 'dirty' }));
    expect(d.status).toBe('conflicts');
    expect(d.actor).toBe('you');
  });
  it('CI failing beats clean; agent owns it when a run is active', () => {
    const d = classifyPr(base({ checks: { total: 3, failing: 1, pending: 0 }, run: safeRun }));
    expect(d.status).toBe('ci_failing');
    expect(d.actor).toBe('agent');
  });
  it('CI running is automatic/no-action', () => {
    const d = classifyPr(base({ checks: { total: 3, failing: 0, pending: 2 } }));
    expect(d.status).toBe('ci_running');
    expect(d.actor).toBe('auto');
  });
  it('changes requested: external → you, active run → agent_revising', () => {
    const cr = { approved: false, changesRequested: true, reviewers: 1 };
    expect(classifyPr(base({ reviews: cr })).status).toBe('changes_requested');
    const agent = classifyPr(base({ reviews: cr, run: safeRun }));
    expect(agent.status).toBe('agent_revising');
    expect(agent.actor).toBe('agent');
  });
});

describe('classifyPr — merge-state disambiguation', () => {
  it('clean + safe active run + auto_merge_safe → auto_merge_pending', () => {
    const d = classifyPr(base({ run: safeRun }));
    expect(d.status).toBe('auto_merge_pending');
    expect(d.actor).toBe('auto');
  });
  it('clean + needs_human run → waiting on human merge (not auto)', () => {
    const d = classifyPr(base({ run: { ...safeRun, blastRadius: 'needs_human' } }));
    expect(d.status).toBe('awaiting_merge');
    expect(d.actor).toBe('you');
  });
  it('clean external PR → awaiting human merge', () => {
    expect(classifyPr(base()).status).toBe('awaiting_merge');
  });
  it('behind: auto self-heal for safe runs, manual otherwise', () => {
    expect(classifyPr(base({ mergeableState: 'behind', run: safeRun })).actor).toBe('auto');
    expect(classifyPr(base({ mergeableState: 'behind' })).actor).toBe('you');
  });
  it('blocked + green checks + no approval → awaiting human review', () => {
    const d = classifyPr(base({ mergeableState: 'blocked' }));
    expect(d.status).toBe('awaiting_review');
    expect(d.actor).toBe('you');
  });
  it('blocked despite approval → protection block (needs a human unblock)', () => {
    const d = classifyPr(base({ mergeableState: 'blocked', reviews: APPROVED }));
    expect(d.status).toBe('blocked');
  });
  it('unstable → mergeable with a warning', () => {
    expect(classifyPr(base({ mergeableState: 'unstable' })).status).toBe('awaiting_merge');
  });
  it('unknown merge state → unknown/no actor', () => {
    const d = classifyPr(base({ mergeableState: 'unknown' }));
    expect(d.status).toBe('unknown');
    expect(d.actor).toBe('none');
  });
});
