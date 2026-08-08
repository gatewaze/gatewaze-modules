// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Pins classifyDecision's disambiguation of the single `blocked` status into the three human-actionable
// sub-kinds (issue #49), plus the other human-gated statuses that are decisions but never hit `blocked`.
import { describe, it, expect } from 'vitest';
import { classifyDecision, decisionTextFor, blockSummaryFor } from '../decision-kind.js';

describe('classifyDecision', () => {
  it('returns null for a live/non-gated run', () => {
    expect(classifyDecision({ status: 'running' }, [])).toBeNull();
    expect(classifyDecision({ status: 'watching' }, [])).toBeNull();
    expect(classifyDecision({ status: 'merged' }, [])).toBeNull();
  });

  it('classifies awaiting_spec directly off status', () => {
    expect(classifyDecision({ status: 'awaiting_spec' }, [])).toBe('awaiting_spec');
  });

  it('classifies both awaiting_architecture and architecture_in_review as awaiting_architecture', () => {
    expect(classifyDecision({ status: 'awaiting_architecture' }, [])).toBe('awaiting_architecture');
    expect(classifyDecision({ status: 'architecture_in_review' }, [])).toBe('awaiting_architecture');
  });

  it('classifies ready_to_submit directly off status', () => {
    expect(classifyDecision({ status: 'ready_to_submit' }, [])).toBe('ready_to_submit');
  });

  it('classifies a blocked run with a closed-unmerged PR as pr_closed_partial', () => {
    const run = { status: 'blocked', error: 'a PR was closed unmerged — partial; needs a human decision' };
    const prs = [{ state: 'closed_unmerged' }];
    expect(classifyDecision(run, prs)).toBe('pr_closed_partial');
  });

  it('classifies a blocked run whose error matches the skeptic-exhausted text as review_blocked', () => {
    const run = { status: 'blocked', error: 'adversarial review blocked (retries exhausted)' };
    expect(classifyDecision(run, [])).toBe('review_blocked');
  });

  it('prefers pr_closed_partial over review_blocked when both signals are present', () => {
    const run = { status: 'blocked', error: 'adversarial review blocked (retries exhausted)' };
    const prs = [{ state: 'closed_unmerged' }];
    expect(classifyDecision(run, prs)).toBe('pr_closed_partial');
  });

  it('falls back to config_blocked for any other blocked run (authorization/kill_switch)', () => {
    expect(classifyDecision({ status: 'blocked', error: 'intake disabled' }, [])).toBe('config_blocked');
    expect(classifyDecision({ status: 'blocked', error: 'project credentials missing' }, [])).toBe('config_blocked');
    expect(classifyDecision({ status: 'blocked', error: null }, [])).toBe('config_blocked');
  });

  it('open or merged PRs on a blocked run do not trigger pr_closed_partial', () => {
    const run = { status: 'blocked', error: 'intake disabled' };
    const prs = [{ state: 'open' }, { state: 'merged' }];
    expect(classifyDecision(run, prs)).toBe('config_blocked');
  });
});

describe('decisionTextFor', () => {
  it('review_blocked includes the revision count', () => {
    expect(decisionTextFor('review_blocked', { retry_count: 2 })).toContain('after 2 revisions');
  });

  it('config_blocked surfaces the raw error text', () => {
    expect(decisionTextFor('config_blocked', { error: 'project credentials missing' })).toBe('project credentials missing');
  });

  it('has plain-language text for every other kind', () => {
    expect(decisionTextFor('pr_closed_partial', {})).toMatch(/human decision/);
    expect(decisionTextFor('awaiting_spec', {})).toBe('Spec awaiting approval');
    expect(decisionTextFor('awaiting_architecture', {})).toBe('Architecture proposal awaiting review');
    expect(decisionTextFor('ready_to_submit', {})).toBe('Pull request ready — awaiting submission');
  });
});

describe('blockSummaryFor', () => {
  it('review_blocked folds the gate objections in', () => {
    const summary = blockSummaryFor('review_blocked', { error: 'adversarial review blocked (retries exhausted)' }, { objections: ['missing tests', 'wrong repo'] });
    expect(summary).toContain('missing tests');
    expect(summary).toContain('wrong repo');
  });

  it('review_blocked without objections still gives a non-empty summary', () => {
    const summary = blockSummaryFor('review_blocked', { error: 'adversarial review blocked (retries exhausted)' }, null);
    expect(summary.length).toBeGreaterThan(0);
  });

  it('config_blocked surfaces the run error', () => {
    expect(blockSummaryFor('config_blocked', { error: 'intake disabled' })).toContain('intake disabled');
  });

  it('pr_closed_partial gives an actionable, non-empty summary', () => {
    expect(blockSummaryFor('pr_closed_partial', { error: 'a PR was closed unmerged — partial; needs a human decision' }).length).toBeGreaterThan(0);
  });
});
