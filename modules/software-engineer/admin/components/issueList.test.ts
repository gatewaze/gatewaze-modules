import { describe, it, expect } from 'vitest';
import { issueKey, mergeIssues, pendingOptimistic } from './issueList';

const opt = (projId: string, number: number, extra: any = {}) =>
  ({ project: { id: projId }, number, _optimistic: true, ...extra });
const real = (projId: string, number: number, extra: any = {}) =>
  ({ project: { id: projId }, repo: 'org/issues', number, ...extra });

describe('issueKey', () => {
  it('keys by project id + number, ignoring repo', () => {
    expect(issueKey(opt('p1', 5))).toBe('p1#5');
    expect(issueKey(real('p1', 5))).toBe('p1#5'); // optimistic (no repo) matches its real counterpart
  });
  it('is null-safe', () => {
    expect(issueKey(undefined)).toBe('undefined#undefined');
    expect(issueKey({})).toBe('undefined#undefined');
  });
});

describe('pendingOptimistic', () => {
  it('keeps optimistic rows the real list has not surfaced yet', () => {
    const pending = pendingOptimistic([opt('p1', 5)], [real('p1', 9)]);
    expect(pending).toHaveLength(1);
    expect(pending[0].number).toBe(5);
  });
  it('drops an optimistic row once the real fetch surfaces it (propagation caught up)', () => {
    expect(pendingOptimistic([opt('p1', 5)], [real('p1', 5)])).toHaveLength(0);
  });
  it('matches only within the same project (same number, different project stays pending)', () => {
    expect(pendingOptimistic([opt('p1', 5)], [real('p2', 5)])).toHaveLength(1);
  });
  it('tolerates empty inputs', () => {
    expect(pendingOptimistic([], [])).toEqual([]);
    expect(pendingOptimistic(undefined as any, undefined as any)).toEqual([]);
  });
});

describe('mergeIssues', () => {
  it('renders pending optimistic rows above the GitHub-backed list', () => {
    const merged = mergeIssues([opt('p1', 5)], [real('p1', 9)]);
    expect(merged.map((i) => i.number)).toEqual([5, 9]);
  });
  it('does not duplicate a row present in both views', () => {
    const merged = mergeIssues([opt('p1', 5)], [real('p1', 5), real('p1', 9)]);
    expect(merged.map(issueKey)).toEqual(['p1#5', 'p1#9']);
  });
  it('returns the real list unchanged when there are no optimistic rows', () => {
    const issues = [real('p1', 1), real('p1', 2)];
    expect(mergeIssues([], issues)).toEqual(issues);
  });
});
