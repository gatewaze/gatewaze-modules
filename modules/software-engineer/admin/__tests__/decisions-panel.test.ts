import { describe, it, expect } from 'vitest';
import { groupDecisions, shouldShowArchitectureLink, KIND_ORDER } from '../components/decisionsPanelUtils';

// This module's vitest env is 'node' (no jsdom), so <DecisionsPanel> itself can't be rendered here —
// see admin/__tests__/project-avatar.test.ts for the same constraint. Instead we pin the pure
// grouping/ordering logic the component delegates to (issue #49 §4's test-plan item: "empty-state
// renders nothing; count badge matches row count; architecture rows show commit-url link only when
// architecture_in_review").
describe('groupDecisions', () => {
  it('returns nothing for an empty list', () => {
    expect(groupDecisions([])).toEqual([]);
  });

  it('buckets by kind and orders per KIND_ORDER regardless of input order', () => {
    const decisions = [
      { id: '1', kind: 'config_blocked' },
      { id: '2', kind: 'awaiting_spec' },
      { id: '3', kind: 'review_blocked' },
    ];
    const grouped = groupDecisions(decisions);
    expect(grouped.map(([kind]) => kind)).toEqual(['awaiting_spec', 'review_blocked', 'config_blocked']);
  });

  it('omits kinds with no rows and preserves the count of rows within a kind', () => {
    const decisions = [
      { id: '1', kind: 'ready_to_submit' },
      { id: '2', kind: 'ready_to_submit' },
    ];
    const grouped = groupDecisions(decisions);
    expect(grouped).toHaveLength(1);
    expect(grouped[0][0]).toBe('ready_to_submit');
    expect(grouped[0][1]).toHaveLength(2);
  });

  it('groups every kind in KIND_ORDER when present, in that exact sequence', () => {
    const decisions = KIND_ORDER.map((kind, i) => ({ id: String(i), kind }));
    const grouped = groupDecisions(decisions);
    expect(grouped.map(([kind]) => kind)).toEqual([...KIND_ORDER]);
  });
});

describe('shouldShowArchitectureLink', () => {
  it('shows the link for awaiting_architecture with a resolved commit url', () => {
    expect(shouldShowArchitectureLink('awaiting_architecture', { architecture_commit_url: 'https://github.com/x/y/commit/abc' })).toBe(true);
  });

  it('hides the link for awaiting_architecture with no commit url yet', () => {
    expect(shouldShowArchitectureLink('awaiting_architecture', {})).toBe(false);
    expect(shouldShowArchitectureLink('awaiting_architecture', { architecture_commit_url: null })).toBe(false);
  });

  it('hides the link for every other kind even if a commit url is present', () => {
    expect(shouldShowArchitectureLink('review_blocked', { architecture_commit_url: 'https://github.com/x/y/commit/abc' })).toBe(false);
    expect(shouldShowArchitectureLink('awaiting_spec', { architecture_commit_url: 'https://github.com/x/y/commit/abc' })).toBe(false);
  });
});
