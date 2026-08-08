import { describe, it, expect, vi } from 'vitest';
import { parseDependencies, unmetDependencies, ensureWaitingMarker, clearWaitingMarker, WAITING_LABEL } from '../dependencies.js';

describe('parseDependencies', () => {
  it('parses the documented forms', () => {
    expect(parseDependencies('Depends on #12')).toEqual([12]);
    expect(parseDependencies('depends-on: #12, #14')).toEqual([12, 14]);
    expect(parseDependencies('DEPENDS ON #3 and #5\nmore text')).toEqual([3, 5]);
    expect(parseDependencies('body\n\nDepends on #7\nDepends on #9')).toEqual([7, 9]);
  });
  it('ignores self-references, duplicates, junk, and bare mentions', () => {
    expect(parseDependencies('Depends on #6 and #6', 6)).toEqual([]);
    expect(parseDependencies('see #12 for context')).toEqual([]);  // no depends-on phrase
    expect(parseDependencies('')).toEqual([]);
    expect(parseDependencies('Depends on nothing really')).toEqual([]);
  });
});

describe('unmetDependencies', () => {
  const gh = (states: Record<number, string | Error>) => ({
    getIssue: vi.fn(async (_o: string, _n: string, num: number) => {
      const v = states[num];
      if (v instanceof Error) throw v;
      return v ? { state: v } : null;
    }),
  });
  it('returns only still-open deps', async () => {
    expect(await unmetDependencies(gh({ 1: 'closed', 2: 'open', 3: 'closed' }), 'o', 'r', [1, 2, 3])).toEqual([2]);
  });
  it('fails open on unfetchable/unknown issues', async () => {
    expect(await unmetDependencies(gh({ 1: new Error('404'), 2: 'open' }), 'o', 'r', [1, 2])).toEqual([2]);
  });
});

describe('waiting marker', () => {
  const mk = () => ({
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    postComment: vi.fn(async () => {}),
  });
  it('labels + comments once, then stays quiet while the label is present', async () => {
    const gh = mk();
    await ensureWaitingMarker(gh, 'o', 'r', 5, [], [2], [1, 2]);
    expect(gh.addLabels).toHaveBeenCalledWith('o', 'r', 5, [WAITING_LABEL]);
    expect(gh.postComment).toHaveBeenCalledTimes(1);
    expect(gh.postComment.mock.calls[0][3]).toContain('#2');
    await ensureWaitingMarker(gh, 'o', 'r', 5, [WAITING_LABEL], [2], [1, 2]);
    expect(gh.postComment).toHaveBeenCalledTimes(1);   // no spam on re-poll
  });
  it('clears the marker only when present', async () => {
    const gh = mk();
    await clearWaitingMarker(gh, 'o', 'r', 5, []);
    expect(gh.removeLabel).not.toHaveBeenCalled();
    await clearWaitingMarker(gh, 'o', 'r', 5, [WAITING_LABEL]);
    expect(gh.removeLabel).toHaveBeenCalledWith('o', 'r', 5, WAITING_LABEL);
  });
});
