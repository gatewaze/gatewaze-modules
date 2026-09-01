import { describe, it, expect } from 'vitest';
import { resumeBlockedReason, resumeHintFor, resumeConfirmText } from '../components/resumeButton';

// Issue #36 — the Resume button on a failed run's detail view must never be a silent no-op: when
// it's disabled, a visible reason is shown next to it. SoftwareEngineerTab.tsx can't be mounted
// under this module's `node` vitest env (no jsdom), so the disabled-with-reason decision is
// extracted into a pure function and pinned here (see triage-button-styles.test.ts for precedent).
describe('resumeBlockedReason', () => {
  it('is enabled (null) for a plain failed, non-archived, non-interactive run', () => {
    expect(resumeBlockedReason({ archived_at: null, kind: 'issue' })).toBeNull();
  });

  it('blocks with a visible reason when the run is archived', () => {
    expect(resumeBlockedReason({ archived_at: '2026-01-01T00:00:00Z', kind: 'issue' })).toBe('Unarchive to resume');
  });

  it('blocks with a visible reason for an interactive session', () => {
    expect(resumeBlockedReason({ archived_at: null, kind: 'interactive' })).toBe("Interactive sessions can't be resumed this way");
  });

  it('archived takes precedence when a run is somehow both archived and interactive', () => {
    expect(resumeBlockedReason({ archived_at: '2026-01-01T00:00:00Z', kind: 'interactive' })).toBe('Unarchive to resume');
  });
});

// Issue #49 §5/§7 — a `blocked` run joined `failed` as resumable. resumeHintFor is informational
// only (never disables the button, since /resume accepts every DecisionKind including
// config_blocked); resumeConfirmText makes the confirm() dialog say what resuming actually does.
describe('resumeHintFor', () => {
  it('is null for a non-blocked run', () => {
    expect(resumeHintFor({ status: 'failed' })).toBeNull();
    expect(resumeHintFor({ status: 'running' })).toBeNull();
  });

  it('surfaces the skeptic objection count for review_blocked', () => {
    const run = { status: 'blocked', error: 'adversarial review blocked (retries exhausted)', retry_count: 2 };
    expect(resumeHintFor(run, [])).toBe('Skeptic rejected the spec after 2 revisions — decide: enrich the issue, override, or drop');
  });

  it('flags a closed-unmerged PR for pr_closed_partial', () => {
    const run = { status: 'blocked', error: 'irrelevant' };
    expect(resumeHintFor(run, [{ state: 'closed_unmerged' }])).toBe('A pull request was closed without merging — needs a human decision');
  });

  it('surfaces the raw error for config_blocked', () => {
    const run = { status: 'blocked', error: 'intake disabled' };
    expect(resumeHintFor(run, [])).toBe('intake disabled');
  });
});

describe('resumeConfirmText', () => {
  it('uses the plain failed-resume text for a non-blocked run', () => {
    expect(resumeConfirmText({ status: 'failed' })).toBe('Resume this run? It will retry the phase that failed.');
  });

  it('is kind-aware for review_blocked', () => {
    const run = { status: 'blocked', error: 'adversarial review blocked (retries exhausted)' };
    expect(resumeConfirmText(run, [])).toBe("Resume this run? The agent will redraft the spec addressing the skeptic's objections.");
  });

  it('is kind-aware for pr_closed_partial', () => {
    const run = { status: 'blocked', error: 'irrelevant' };
    expect(resumeConfirmText(run, [{ state: 'closed_unmerged' }])).toBe('Resume this run? The agent will revise the code to address why the pull request was closed.');
  });

  it('warns that config_blocked will likely re-block without a config fix', () => {
    const run = { status: 'blocked', error: 'intake disabled' };
    expect(resumeConfirmText(run, [])).toBe('Resume this run? It will retry the same phase — if the underlying configuration issue is not fixed, it will likely block again.');
  });
});
